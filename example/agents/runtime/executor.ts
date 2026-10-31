// Compiling and calling a generated executor (issue #215). Split from improve.ts so that the child
// process a generated strategy runs in (strategyRunner.ts) loads this and its few imports, not the
// revision loop and its model clients.
import { isProxy } from "node:util/types";
import { compileFunction, createContext, Script } from "node:vm";
import { findCheatcodeUsage } from "@eris/sdk/strategyStaticCheck.js";
import type { AgentContext } from "@eris/sdk/agent.js";
import type { AgentAction, AgentObservation } from "@eris/sdk/types.js";
import { DecideTimeoutError, withDecideTimeout } from "./decideTimeout.js";

// A compiled executor: the same shape as a rule agent's decide, so the trading loop does not care
// which one it is holding.
export type Executor = (
  obs: AgentObservation,
  ctx: AgentContext,
) => Promise<AgentAction | null | undefined> | AgentAction | null | undefined;

export type CompileResult =
  { ok: true; executor: Executor } | { ok: false; reason: string };

// What runs inside the vm context, evaluated there once per compile (issue #215). The context is
// created empty, so these are the context's own functions and the objects they build have the
// context's prototypes. That is the whole point: a host object reachable from generated code is a
// host realm reachable from it (`obs.constructor.constructor("return process")()` is the host's
// Function constructor evaluating in the host realm -- `process.env`, and with it whatever the
// child process's environment holds). So what goes in is copied, what comes back is copied, and host
// functions are only ever called from behind a function of this realm.
//
// Every built-in the bridge uses is taken into a constant here, when it is evaluated, and called
// through that constant from then on -- never looked up when it runs. The lookups were the hole
// (audit #4a): `Object.keys`, `Array.isArray`, `Object.prototype.toString`, `Promise.resolve`,
// `seen.get` (Map.prototype), `.then` (Promise.prototype) are this realm's, generated code runs in
// this realm, and each of them was handed a host value. A strategy that replaced one and then called
// `ctx.latestObservation()` received the host observation itself. The lockdown below freezes all of
// them before generated code is compiled; this capture is what still holds where a lookup would go
// somewhere the freeze does not reach, and the freeze is what covers the lookups no capture can
// remove (the engine's own, inside a built-in). The bridge is strict, so a function of it is never
// handed out by `caller`, and it assigns a property only where nothing on the frozen prototype
// chain has the name (see `define`).
//
// Host code runs whenever the bridge reads a host value (a proxy trap, a getter) or calls a host
// function, and anything it throws is a host object -- a RangeError at the stack limit included,
// which generated code can arrange by recursing before it calls in. So every such read is inside a
// try whose catch hands back a copy.
const EXECUTOR_BRIDGE = `(() => {
  "use strict";
  const apply = Reflect.apply;
  const defineProperty = Object.defineProperty;
  const keys = Object.keys;
  const isArray = Array.isArray;
  // fn(self, ...args) without looking up fn.call: the arguments array is a rest parameter, which is
  // built without the iterator protocol, and Reflect.apply reads it by index.
  const uncurry = (fn) => (self, ...args) => apply(fn, self, args);
  const toStringTag = uncurry(Object.prototype.toString);
  const MapCtor = Map;
  const mapGet = uncurry(Map.prototype.get);
  const mapSet = uncurry(Map.prototype.set);
  const mapForEach = uncurry(Map.prototype.forEach);
  const SetCtor = Set;
  const setAdd = uncurry(Set.prototype.add);
  const setForEach = uncurry(Set.prototype.forEach);
  const DateCtor = Date;
  const getTime = uncurry(Date.prototype.getTime);
  const ErrorCtor = Error;
  const Uint8ArrayCtor = Uint8Array;
  const ProxyCtor = Proxy;
  // An own data property. Assignment walks the prototype chain -- a setter there, a frozen built-in
  // that refuses it (an observation keyed by a token called "hasOwnProperty" would make every copy
  // throw), \`__proto__\` -- and definition does not, but definition is several times slower, and an
  // observation is mostly keys. So a key is defined when this realm's Object.prototype has the name
  // and assigned otherwise: the lockdown freezes that prototype before any of this runs, so the set
  // of names on the chain of a fresh object or array is the one read here.
  const define = (o, k, value) => {
    defineProperty(o, k, { __proto__: null, value, writable: true, enumerable: true, configurable: true });
  };
  const onChain = { __proto__: null };
  const inherited = Object.getOwnPropertyNames(Object.prototype);
  for (let i = 0; i < inherited.length; i++) onChain[inherited[i]] = true;
  const copyKeys = (v, out, seen, defineAll) => {
    const ks = keys(v);
    for (let i = 0; i < ks.length; i++) {
      const k = ks[i];
      const x = copyIn(v[k], seen);
      if (defineAll || onChain[k] === true) define(out, k, x);
      else out[k] = x;
    }
    return out;
  };
  // Deep copy of plain data into this realm. Functions are dropped: an observation carries none,
  // and a host function in the copy would be the escape the copy exists to prevent.
  const copyIn = (v, seen = new MapCtor()) => {
    if (v === null || typeof v !== "object") return typeof v === "function" ? undefined : v;
    const hit = mapGet(seen, v);
    if (hit !== undefined) return hit;
    if (isArray(v)) {
      const out = [];
      mapSet(seen, v, out);
      // Indices: neither Array.prototype nor Object.prototype has one.
      const n = v.length;
      for (let i = 0; i < n; i++) out[i] = copyIn(v[i], seen);
      return out;
    }
    switch (toStringTag(v)) {
      case "[object Date]":
        return new DateCtor(getTime(v));
      case "[object Error]": {
        // Error.prototype is on this chain too (name, message), so every key is defined.
        const out = new ErrorCtor(typeof v.message === "string" ? v.message : undefined);
        mapSet(seen, v, out);
        define(out, "name", typeof v.name === "string" ? v.name : "Error");
        return copyKeys(v, out, seen, true);
      }
      case "[object Map]": {
        const out = new MapCtor();
        mapSet(seen, v, out);
        mapForEach(v, (x, k) => { mapSet(out, copyIn(k, seen), copyIn(x, seen)); });
        return out;
      }
      case "[object Set]": {
        const out = new SetCtor();
        mapSet(seen, v, out);
        setForEach(v, (x) => { setAdd(out, copyIn(x, seen)); });
        return out;
      }
      case "[object Uint8Array]":
        return new Uint8ArrayCtor(v);
    }
    const out = {};
    mapSet(seen, v, out);
    return copyKeys(v, out, seen);
  };
  // What a failed host call throws, as this realm's. The copy reads only data properties of an
  // ordinary error, so it runs no host code; anything else that goes wrong in it is replaced rather
  // than rethrown, because what it threw could be the host's.
  const settle = (e) => {
    try {
      return copyIn(e);
    } catch {
      return new ErrorCtor("a host error could not be copied");
    }
  };
  // A host function called from here: what it returns, throws, or settles to is this realm's.
  // \`await\` resolves through the engine's own promise machinery, not \`Promise.resolve\` or
  // \`.then\` looked up here.
  const call = (thunk) => {
    try {
      return copyIn(thunk());
    } catch (e) {
      throw settle(e);
    }
  };
  const callAsync = async (thunk) => {
    try {
      return copyIn(await thunk());
    } catch (e) {
      throw settle(e);
    }
  };
  // The read-only client: every method call goes to the host client and its result comes back
  // copied. A property that is not a function (chain, batch) is copied; one the client does not
  // have is absent here too -- \`then\` in particular, or this would be a thenable. The arguments
  // go out as they are and the host side copies them (hostReadClient below): copying them here
  // would build the copy with this realm's functions, which is no protection against this realm.
  // The handler has no prototype, so a trap it does not define is not looked up on Object.prototype.
  const wrapClient = (host) =>
    new ProxyCtor({}, {
      __proto__: null,
      get(_, key) {
        let v;
        try {
          v = host[key];
        } catch (e) {
          throw settle(e);
        }
        if (typeof v === "function") return (...args) => callAsync(() => apply(v, host, args));
        return call(() => v);
      },
      has(_, key) {
        try {
          return key in host;
        } catch (e) {
          throw settle(e);
        }
      },
    });
  const wrapContext = (host) => ({
    agentId: copyIn(host.agentId),
    address: copyIn(host.address),
    config: copyIn(host.config),
    publicClient: wrapClient(host.publicClient),
    latestObservation: () => call(() => host.latestObservation()),
    // The host calls back into a function of this realm, never the strategy's own: the callback
    // would otherwise be handed a host observation, and its constructor is the host's.
    onObservation: (cb) => call(() => host.onObservation((o) => { cb(copyIn(o)); })),
    submit: (action) => call(() => host.submit(action)),
    log: (entry) => call(() => host.log(entry)),
  });
  // What the strategy threw, as text made here. Turning it into text runs its code (toString, a
  // getter, a proxy trap), which is harmless in this realm; on the host's side a String(x) ran it
  // outside any try, and what it threw from there was the strategy's value again, loose in the host.
  // So the host is handed a string and nothing else.
  const StringCtor = String;
  const describe = (e) => {
    try {
      const text = typeof e === "string" ? e : StringCtor(e);
      if (typeof text === "string") return text;
    } catch {}
    return "the strategy threw a value that could not be turned into text";
  };
  // The one way the host calls generated code. The call is made from this realm, so whatever it
  // reaches is handed this realm's values (a callable Proxy's apply trap gets its arguments array
  // from the realm that calls it), and the host only ever holds the promise of this async arrow,
  // which settles to the strategy's answer or rejects with a string.
  const invoke = async (decide, obs, host) => {
    try {
      return await decide(copyIn(obs), wrapContext(host));
    } catch (e) {
      throw describe(e);
    }
  };
  return { invoke };
})()`;

type ExecutorBridge = {
  invoke(decide: unknown, obs: AgentObservation, host: AgentContext): Promise<unknown>;
};

// Run in the context after the bridge has taken what it needs and before generated code is compiled
// into it. Freezing alone would leave the globals rebindable (`globalThis.Uint8Array = evil`); the
// capture above alone would leave the lookups a built-in makes on its receiver. So both, and the
// lockdown also closes what a built-in hands generated code later: `Error.prepareStackTrace` (Node
// asks the error's own realm for it), a `then` on Object.prototype, the iterator prototypes that
// only syntax reaches.
//
// What stays open, on purpose: the global object itself is extensible, so a strategy can keep state
// across calls on `globalThis` (the context lives as long as the process). V8 also refuses to freeze
// a contextified global ("Cannot freeze"), so the bindings are made non-writable and non-configurable
// one by one instead, which it does allow. A binding that cannot be fixed fails the compile.
//
// The override mistake: a frozen `Error.prototype.name` makes `this.name = "X"` in an Error
// subclass throw (class bodies are strict), and `o.toString = f` on a plain object fail. Those few,
// on Object, Function and the Error prototypes, become accessors whose setter defines the property
// on the receiver instead, the way SES's lockdown handles it. Any other built-in property is
// read-only on instances too: `arr.filter = f` is ignored (or throws, in strict code), while
// `Object.defineProperty(arr, "filter", ...)` still works.
//
// Three things are removed rather than frozen, because Node rather than the engine answers them.
// WebAssembly's streaming functions hand their argument to Node, which rejects a non-Response with an
// error of its own realm: `WebAssembly.compileStreaming(1)`, and the rejection's
// `constructor.constructor` is the host's Function (wasm code generation is off in the context as
// well). `Symbol.for` is the only way to a registered symbol, and Node reads registered symbols off
// arbitrary objects -- `nodejs.util.inspect.custom` above all, which util.inspect calls with the host's
// `inspect` as an argument. Without it, nothing generated code makes can carry one, whichever host
// path inspects it (`Symbol.keyFor` goes with it). Strategies have no use for either.
const EXECUTOR_LOCKDOWN = `(() => {
  "use strict";
  const { freeze, getOwnPropertyDescriptor, getPrototypeOf } = Object;
  const { defineProperty, deleteProperty, ownKeys } = Reflect;
  const TypeErrorCtor = TypeError;
  const removed = [[globalThis, "WebAssembly"], [Symbol, "for"], [Symbol, "keyFor"]];
  for (let i = 0; i < removed.length; i++) {
    const owner = removed[i][0];
    const name = removed[i][1];
    deleteProperty(owner, name);
    if (getOwnPropertyDescriptor(owner, name) !== undefined)
      throw new TypeErrorCtor("could not remove " + name);
  }
  const overridable = (proto, names) => {
    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      const desc = getOwnPropertyDescriptor(proto, name);
      if (desc === undefined || !("value" in desc) || !desc.configurable) continue;
      const value = desc.value;
      defineProperty(proto, name, {
        __proto__: null,
        get() {
          return value;
        },
        set(next) {
          if (this === proto)
            throw new TypeErrorCtor("Cannot assign to read only property '" + name + "' of a built-in prototype");
          if (this === null || (typeof this !== "object" && typeof this !== "function")) return;
          const own = { __proto__: null, value: next, writable: true, enumerable: true, configurable: true };
          if (!defineProperty(this, name, own))
            throw new TypeErrorCtor("Cannot assign to read only property '" + name + "'");
        },
        enumerable: desc.enumerable,
        configurable: false,
      });
    }
  };
  overridable(Object.prototype, ["constructor", "toString", "valueOf", "toLocaleString"]);
  overridable(Function.prototype, ["constructor", "toString"]);
  const errors = [Error, EvalError, RangeError, ReferenceError, SyntaxError, TypeError, URIError, AggregateError];
  if (typeof SuppressedError === "function") errors.push(SuppressedError);
  for (let i = 0; i < errors.length; i++) overridable(errors[i].prototype, ["constructor", "name", "message"]);

  // Everything reachable from the global object, plus the intrinsics only syntax or an instance
  // reaches. A feature the engine lacks has nothing to freeze.
  const roots = [globalThis];
  const anonymous = [
    () => getPrototypeOf(function* () {}),
    () => getPrototypeOf(async function () {}),
    () => getPrototypeOf(async function* () {}),
    () => getPrototypeOf([][Symbol.iterator]()),
    () => getPrototypeOf(new Map()[Symbol.iterator]()),
    () => getPrototypeOf(new Set()[Symbol.iterator]()),
    () => getPrototypeOf(""[Symbol.iterator]()),
    () => getPrototypeOf(/x/[Symbol.matchAll]("")),
    () => getPrototypeOf(Iterator.from({ next() {} })),
    () => getPrototypeOf([].values().map((x) => x)),
    () => getPrototypeOf(new Intl.Segmenter().segment("")),
    () => getPrototypeOf(new Intl.Segmenter().segment("")[Symbol.iterator]()),
  ];
  for (let i = 0; i < anonymous.length; i++) {
    let found;
    try {
      found = anonymous[i]();
    } catch {
      continue;
    }
    roots.push(found);
  }
  const visited = new Set();
  while (roots.length > 0) {
    const o = roots.pop();
    if ((typeof o !== "object" && typeof o !== "function") || o === null || visited.has(o)) continue;
    visited.add(o);
    if (o !== globalThis) freeze(o);
    roots.push(getPrototypeOf(o));
    const ks = ownKeys(o);
    for (let i = 0; i < ks.length; i++) {
      const d = getOwnPropertyDescriptor(o, ks[i]);
      if (d === undefined) continue;
      if ("value" in d) roots.push(d.value);
      else roots.push(d.get, d.set);
    }
  }

  // The descriptor is given in full: Node's interceptor for a contextified global copies a
  // definition onto the context object, and a data descriptor without a value would copy undefined.
  const names = ownKeys(globalThis);
  for (let i = 0; i < names.length; i++) {
    const d = getOwnPropertyDescriptor(globalThis, names[i]);
    if (d === undefined) continue;
    const data = "value" in d;
    if (!d.configurable && (!data || !d.writable)) continue;
    const fixed = data
      ? { __proto__: null, value: d.value, writable: false, enumerable: d.enumerable, configurable: false }
      : { __proto__: null, get: d.get, set: d.set, enumerable: d.enumerable, configurable: false };
    if (!defineProperty(globalThis, names[i], fixed))
      throw new TypeErrorCtor("could not fix the global binding " + String(names[i]));
  }
})()`;

// The source runs only inside the bridge's invoke, as the body of an async function. It is compiled
// as a function body (vm.compileFunction), not evaluated as an expression: with a Script the body
// could close the wrapper with `});` and put statements after it, and those ran at compile time --
// in the parent process, which compiles every revision to validate it and holds the wallet key.
const executorBody = (source: string) =>
  `return (async function decide(obs, ctx) {\n${source}\n})(obs, ctx);`;

// Text for something caught where generated code may have supplied it. Only a string or an error of
// this realm is read (a DataCloneError, a stack overflow, the process's own failures). Anything else
// may be the vm's, and its toString, its getters and its prototype chain are generated code: running
// them here is what turned a thrown value into a second throw outside every try, and an unhandled
// rejection ends in util.inspect, which hands the host's `inspect` to the value's
// custom inspect function. So it is not stringified and no property of it is read.
export function hostErrorText(error: unknown, otherwise: string): string {
  try {
    if (typeof error === "string") return error;
    if (!isProxy(error) && error instanceof Error) {
      const message = error.message;
      if (typeof message === "string") return message;
    }
  } catch {
    // Whatever threw here is not looked at either.
  }
  return otherwise;
}

// A value the generated code built, brought into this realm before anyone downstream touches it.
// Actions, log entries and submissions are plain data by contract, so a structural clone loses
// nothing; anything unclonable was not valid in the first place. The clone runs the value's getters,
// so what it throws can be the strategy's own value (hostErrorText).
function toHostRealm<T>(what: string, value: T): T {
  try {
    return structuredClone(value);
  } catch (error) {
    throw new Error(
      `${what} is not plain data: ${hostErrorText(error, "a getter of it threw")}`,
    );
  }
}

// The client the bridge calls, with what the strategy passes it copied into this realm first. The
// arguments are the strategy's objects, and viem calls methods on them: `abi.filter(cb)` in
// getAbiItem runs whatever the strategy put at `abi.filter`, handing it viem's callback -- a function
// of this realm, and `cb.constructor("return process")()` is this realm's process. A structural
// clone keeps what a read legitimately carries (bigint args, byte arrays) and throws on a function,
// so a strategy that passes one gets a rejected read rather than a read with the function dropped.
function hostReadClient(client: AgentContext["publicClient"]): AgentContext["publicClient"] {
  if (typeof client !== "object" || client === null) return client;
  return new Proxy(client, {
    get(target, key) {
      const v = Reflect.get(target, key, target);
      if (typeof v !== "function") return v;
      return (...args: unknown[]) =>
        Reflect.apply(v, target, toHostRealm(`the arguments to publicClient.${String(key)}`, args));
    },
  });
}

// Compile generated source into a callable inside a vm context.
//
// Be clear about what this does and does not contain. The vm removes *ambient* capability: there is
// no require, no process, no fs, no fetch in scope, and since issue #215 nothing of this realm in
// the context's either -- the context is created empty, the observation and the context are copied
// into it, and what a read returns is copied on the way back (EXECUTOR_BRIDGE above), and the
// context's built-ins are frozen before generated code is compiled into it (EXECUTOR_LOCKDOWN). It
// does not sandbox the agent from the chain, because `ctx` is passed in and carries a read-only
// publicClient and submit() -- generated code can trade exactly as freely as the hand-written
// strategy it replaces. That is intentional (it is the same capability, not an escalation), but it
// means the vm is a guard against a model reaching for something outside the trading interface, not
// a containment boundary (ADR 0024): the child process it runs in never held a secret and runs under
// Node's permission model (strategyRunner.ts), so that an escape nobody has thought of finds nothing
// to take and nowhere to write. The cheatcode
// check below is the part that addresses intent, and it is what stops generated code from calling
// the privileged RPCs that a participant's own code is also forbidden from calling.
//
// Compiling runs nothing from the source, which matters because the parent process (it holds the
// wallet key) compiles every revision to validate it; the code itself only ever runs in the child.
export function compileExecutor(source: string): CompileResult {
  const findings = findCheatcodeUsage(source);
  if (findings.length > 0)
    return {
      ok: false,
      reason:
        `generated code uses privileged calls: ` +
        findings
          .map((f) => `${f.rule} "${f.match}" (line ${f.line})`)
          .join("; "),
    };

  try {
    // Empty: the context's own Math, JSON, Object, Array, BigInt, Map, Set and the rest are what a
    // strategy legitimately needs, and they are the context's. The host's used to be handed in
    // here, and `Object.constructor("return process")()` was the host's Function constructor.
    // Empty *and without a prototype*: the object handed to createContext is a host object that
    // the context's global proxy consults first, prototype chain included, so with a plain `{}`
    // `this.constructor` at the top of the strategy is the host's Object and
    // `this.constructor.constructor("return process")()` is the host's process.
    // No code from strings: eval and the Function constructors throw an EvalError of the context,
    // so the source is all the code there is. No wasm either (EXECUTOR_LOCKDOWN also removes the
    // WebAssembly namespace).
    const sandbox = createContext(Object.create(null), {
      codeGeneration: { strings: false, wasm: false },
    });
    const { invoke } = new Script(EXECUTOR_BRIDGE, {
      filename: "executor-bridge.js",
    }).runInContext(sandbox) as ExecutorBridge;
    new Script(EXECUTOR_LOCKDOWN, { filename: "executor-lockdown.js" }).runInContext(sandbox);
    // The source is the *body* of decide(obs, ctx). Wrapping it here rather than asking the model to
    // emit a complete module keeps the contract small: an import declaration is a syntax error in a
    // function body, and so is `import.meta`. A dynamic `import()` compiles and rejects when it runs
    // (there is no module loader behind the context), with an error of Node's realm -- one
    // `.constructor.constructor` from this process's `process`. That used to be refused in the
    // source, because this process was the agent's. It no longer is: generated code runs in a child
    // process that never held a credential, under Node's permission model with nothing to read but
    // its own bundle, nothing to write and nothing to spawn (strategyRunner.ts).
    const decide = compileFunction(executorBody(source), ["obs", "ctx"], {
      parsingContext: sandbox,
      filename: "generated-executor.js",
    });

    // Both directions cross the realm boundary as copies. In: the observation and the context
    // (EXECUTOR_BRIDGE). Out: the action, and what the strategy logs or submits -- an object built
    // inside the vm has that context's Object.prototype, so it is not `instanceof Object` here and
    // deep-equality against a host object fails, exactly the kind of difference that shows up far
    // from its cause, in validation or logging, rather than at the boundary.
    //
    // Standalone callers still get the async timeout. Production calls execute in a child process with
    // the same parent-owned deadline, which can also terminate synchronous loops and callbacks.
    const normalized: Executor = async (obs, ctx) => {
      const hostFacing: AgentContext = {
        ...ctx,
        publicClient: hostReadClient(ctx.publicClient),
        submit: (action) => ctx.submit(toHostRealm("a submitted action", action)),
        log: (entry) => ctx.log(toHostRealm("a log entry", entry)),
      };
      let result: unknown;
      try {
        result = await withDecideTimeout(invoke(decide, obs, hostFacing), obs.round);
      } catch (error) {
        // invoke rejects with a string only (the bridge's describe); the timeout is this realm's.
        if (typeof error === "string") throw new Error(error);
        let timeout = false;
        try {
          timeout = error instanceof DecideTimeoutError;
        } catch {
          // Not this realm's, then.
        }
        if (timeout) throw error;
        throw new Error("the strategy failed with a value that is not text");
      }
      if (result === null || result === undefined) return null;
      return toHostRealm("the executor's return value", result) as AgentAction;
    };
    return { ok: true, executor: normalized };
  } catch (error) {
    // A syntax error from compileFunction is the context's SyntaxError, not `instanceof Error` here.
    const message = (error as { message?: unknown } | null)?.message;
    return {
      ok: false,
      reason: `compile failed: ${typeof message === "string" ? message : String(error)}`,
    };
  }
}
