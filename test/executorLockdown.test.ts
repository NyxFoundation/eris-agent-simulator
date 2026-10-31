// Generated code against the vm realm it runs in (audit #4a and what was found next to it).
//
// Issue #215 made the context empty and the bridge copy everything across, so generated code holds
// no object of the runtime's. That held only while the bridge's own lookups were the engine's: the
// bridge called `Object.keys`, `Array.isArray`, `Promise.resolve`, `seen.get` ... at call time, in
// the realm generated code runs in, with host values as arguments. A strategy that replaced one of
// them and then called `ctx.latestObservation()` was handed the host observation, and
// `.constructor.constructor("return process")()` on it was the host's process. Each case below
// tampers with something, drives every path through the bridge, and then tries the host's Function
// constructor on everything it was handed. None may reach the marker in this process's environment.
import test from "node:test";
import assert from "node:assert/strict";
import { compileExecutor } from "../example/agents/runtime/improve.js";

const MARKER_NAME = "ERIS_TEST_LOCKDOWN_MARKER";
const MARKER = "host-only-4a";

function withMarker(t: test.TestContext) {
  process.env[MARKER_NAME] = MARKER;
  t.after(() => {
    delete process.env[MARKER_NAME];
  });
}

// Every shape copyIn has a branch for, so a tampered intrinsic on any branch is exercised.
function observation() {
  return {
    round: 7,
    nested: { amount: 123n, list: [1, 2, { deep: true }] },
    when: new Date(0),
    bytes: new Uint8Array([1, 2, 3]),
    byToken: new Map([["WETH", { price: 3000 }]]),
    tags: new Set(["a"]),
  };
}

function hostContext() {
  return {
    agentId: "alice",
    address: "0x0000000000000000000000000000000000000001",
    config: { chainId: 31337, nested: { fee: [30] } },
    publicClient: {
      chain: { id: 31337 },
      getBlockNumber: async () => 42n,
      readContract: async () => ({
        reserves: [1n, 2n],
        at: new Date(0),
        raw: new Uint8Array([9]),
        byKey: new Map([["k", { v: 1 }]]),
      }),
      call: async () => {
        throw Object.assign(new Error("execution reverted"), { details: { data: "0x" } });
      },
    },
    latestObservation: () => observation(),
    onObservation: () => () => {},
    submit: () => {},
    log: () => {},
  } as never;
}

// Keeps every object a tampered function is handed (index loops and plain assignment only, so the
// harness does not trip over what it tampered with), touches every bridge path, then tries each.
const harness = (tamper: string) => `
  const kept = [];
  const grab = (v) => {
    if (kept.length < 1000 && v !== null && (typeof v === "object" || typeof v === "function")) kept[kept.length] = v;
  };
  let tampered = "applied";
  try { ${tamper} } catch (e) { tampered = "refused: " + e.message; }
  const seen = {};
  try { seen.latest = ctx.latestObservation().round; } catch (e) { seen.latest = "threw: " + e.message; }
  try { seen.block = await ctx.publicClient.getBlockNumber(); } catch (e) { seen.block = "threw: " + e.message; }
  try { seen.read = (await ctx.publicClient.readContract({})).reserves[1]; } catch (e) { seen.read = "threw: " + e.message; }
  try { await ctx.publicClient.call({}); } catch (e) { seen.reverted = e.message; }
  try { seen.chain = ctx.publicClient.chain.id; } catch (e) { seen.chain = "threw: " + e.message; }
  try { ctx.log({ reason: "probe" }); ctx.submit({ type: "noop" }); } catch (e) {}
  try { seen.when = obs.when.getTime(); seen.bytes = obs.bytes[2]; seen.price = obs.byToken.get("WETH").price; } catch (e) { seen.obs = "threw: " + e.message; }
  try { const e = new Error("x"); seen.stack = typeof e.stack; } catch (e) {}
  let reached = "";
  for (let i = 0; i < kept.length; i++) {
    try {
      reached += String(kept[i].constructor.constructor("return process")().env.${MARKER_NAME});
    } catch (e) {}
  }
  return { type: "noop", tampered, kept: kept.length, reached, seen };
`;

const TAMPERINGS: Record<string, string> = {
  // The four the audit reproduced.
  "Object.keys": `const f = Object.keys; Object.keys = function (v) { grab(v); return f(v); };`,
  "Array.isArray": `const f = Array.isArray; Array.isArray = function (v) { grab(v); return f(v); };`,
  "Object.prototype.toString": `const f = Object.prototype.toString;
    Object.prototype.toString = function () { grab(this); return f.call(this); };`,
  "Promise.resolve": `const f = Promise.resolve; Promise.resolve = function (v) { grab(v); return f.call(this, v); };`,
  // The implicit lookups: methods reached through the receiver, not a global.
  "Map.prototype.get": `const f = Map.prototype.get; Map.prototype.get = function (k) { grab(k); return f.call(this, k); };`,
  "Map.prototype.set": `const f = Map.prototype.set;
    Map.prototype.set = function (k, v) { grab(k); grab(v); return f.call(this, k, v); };`,
  "Promise.prototype.then": `const f = Promise.prototype.then;
    Promise.prototype.then = function (ok, no) {
      grab(ok); grab(no);
      return f.call(this, (v) => { grab(v); return typeof ok === "function" ? ok(v) : v; }, no);
    };`,
  "Array.prototype[Symbol.iterator]": `const f = Array.prototype[Symbol.iterator];
    Array.prototype[Symbol.iterator] = function () { grab(this); return f.call(this); };`,
  "%ArrayIteratorPrototype%.next": `const p = Object.getPrototypeOf([][Symbol.iterator]()); const f = p.next;
    p.next = function () { grab(this); const r = f.call(this); grab(r.value); return r; };`,
  "Function.prototype.call": `const f = Function.prototype.call;
    Function.prototype.call = function (self, ...a) { grab(self); for (let i = 0; i < a.length; i++) grab(a[i]); return Reflect.apply(this, self, a); };`,
  "Function.prototype.apply": `Function.prototype.apply = function (self, a) {
      grab(self); if (a) for (let i = 0; i < a.length; i++) grab(a[i]);
      return Reflect.apply(this, self, a || []);
    };`,
  "Reflect.apply": `const f = Reflect.apply;
    Reflect.apply = function (fn, self, a) { grab(fn); grab(self); for (let i = 0; i < a.length; i++) grab(a[i]); return f(fn, self, a); };`,
  "Date.prototype.getTime": `const f = Date.prototype.getTime; Date.prototype.getTime = function () { grab(this); return f.call(this); };`,
  "an accessor on Object.prototype": `Object.defineProperty(Object.prototype, "then", {
      get() { grab(this); return undefined; }, configurable: true,
    });`,
  "Error.prepareStackTrace": `Error.prepareStackTrace = (e, frames) => {
      for (let i = 0; i < frames.length; i++) { grab(frames[i].getThis()); grab(frames[i].getFunction()); }
      return "";
    };`,
  // Global rebinding: the constructors the bridge builds its copies with.
  "globalThis.Map": `const M = Map;
    globalThis.Map = function () {
      const m = new M();
      return { get: (k) => { grab(k); return m.get(k); }, set: (k, v) => { grab(k); grab(v); m.set(k, v); }, forEach: (cb) => m.forEach(cb) };
    };`,
  "globalThis.Uint8Array": `const U = Uint8Array; globalThis.Uint8Array = function (v) { grab(v); return new U(0); };`,
  "globalThis.Date": `const D = Date; globalThis.Date = function (t) { grab(t); return new D(0); };`,
  "globalThis.Error": `const E = Error; globalThis.Error = function (m) { grab(m); return new E(String(m)); };`,
  "globalThis.Promise": `const P = Promise;
    globalThis.Promise = function (executor) { grab(executor); return new P(executor); };
    globalThis.Promise.resolve = (v) => { grab(v); return P.resolve(v); };`,
  "globalThis.Proxy": `const X = Proxy; globalThis.Proxy = function (t, h) { grab(t); grab(h); return new X(t, h); };`,
};

for (const [name, tamper] of Object.entries(TAMPERINGS)) {
  test(`lockdown: ${name} replaced by generated code hands it nothing of the host's`, async (t) => {
    withMarker(t);
    const r = compileExecutor(harness(tamper));
    assert.ok(r.ok, r.ok ? "" : r.reason);
    const out = (await r.executor(observation() as never, hostContext())) as unknown as {
      reached: string;
      seen: Record<string, unknown>;
    };
    assert.equal(out.reached, "", `${name}: reached the host's process`);
    // And the strategy still got its data: the tampering did not merely break the bridge.
    assert.deepEqual(
      { ...out.seen, stack: undefined },
      {
        latest: 7,
        block: 42n,
        read: 2n,
        reverted: "execution reverted",
        chain: 31337,
        when: 0,
        bytes: 3,
        price: 3000,
        stack: undefined,
      },
      name,
    );
  });
}

test("lockdown: the built-ins are frozen and the global bindings cannot be replaced", async () => {
  const r = compileExecutor(`
    "use strict";
    const refused = (f) => { try { f(); return "allowed"; } catch (e) { return e.constructor.name; } };
    const E = Error;
    // Node's interceptor for a contextified global answers a strict delete of a non-configurable
    // binding with false rather than a TypeError; what matters is that the binding is still there.
    let deleted;
    try { deleted = delete globalThis.Error; } catch (e) { deleted = e.constructor.name; }
    return {
      type: "noop",
      frozen: [Object, Object.prototype, Array.prototype, Function.prototype, Promise.prototype,
        Map.prototype, Reflect, JSON, Object.getPrototypeOf([][Symbol.iterator]()),
        Object.getPrototypeOf(async function () {}), Object.getPrototypeOf(Uint8Array)].every(Object.isFrozen),
      assign: refused(() => { globalThis.Uint8Array = 1; }),
      define: refused(() => { Object.defineProperty(globalThis, "Map", { value: 1 }); }),
      remove: deleted !== true && Error === E,
      addToPrototype: refused(() => { Object.prototype.polluted = 1; }),
      // The global object itself stays open: state across calls is the strategy's to keep there.
      memo: (globalThis.memo = (globalThis.memo || 0) + 1),
    };
  `);
  assert.ok(r.ok, r.ok ? "" : r.reason);
  const first = await r.executor({ round: 1 } as never, hostContext());
  assert.deepEqual(first, {
    type: "noop",
    frozen: true,
    assign: "TypeError",
    define: "TypeError",
    remove: true,
    addToPrototype: "TypeError",
    memo: 1,
  });
  assert.equal(((await r.executor({ round: 2 } as never, hostContext())) as unknown as { memo: number }).memo, 2);
  // What was frozen is the context's, not this process's.
  assert.ok(!Object.isFrozen(Object.prototype));
  assert.ok(!Object.isFrozen(Map.prototype));
  assert.ok(!Object.isFrozen(console));
});

test("lockdown: an ordinary strategy still runs, including what freezing would otherwise break", async () => {
  // The override mistake: with Error.prototype.name frozen, `this.name = ...` in an Error subclass
  // throws (class bodies are strict). Error, Object and Function prototypes keep it working.
  const r = compileExecutor(`
    class StrategyError extends Error {
      constructor(message) { super(message); this.name = "StrategyError"; }
    }
    class Book {
      constructor() { this.levels = new Map(); }
      add(price, size) { this.levels.set(price, (this.levels.get(price) || 0n) + size); return this; }
      toString() { return "book(" + this.levels.size + ")"; }
    }
    const state = (globalThis.state = globalThis.state || { calls: 0 });
    state.calls += 1;
    const tag = {};
    tag.toString = () => "tagged";
    let caught;
    try { throw new StrategyError("too thin"); } catch (e) {
      caught = e.name + ":" + e.message + ":" + (e instanceof StrategyError) + ":" + (e instanceof Error);
    }
    const book = new Book().add(3000, obs.nested.amount).add(3000, 1n);
    const sorted = [...obs.nested.list].filter((x) => typeof x === "number").sort((a, b) => b - a);
    const { reserves } = await ctx.publicClient.readContract({ functionName: "getReserves" });
    const [r0, r1] = reserves;
    const latest = ctx.latestObservation();
    ctx.log({ reason: "sized", signals: { book: String(book), tag: String(tag) } });
    return {
      type: "noop",
      caught,
      book: String(book),
      size: book.levels.get(3000),
      tag: \`\${tag}\`,
      sorted,
      ratio: Number((r1 * 10_000n) / r0) / 10_000,
      when: obs.when.toISOString(),
      byToken: Object.fromEntries(obs.byToken),
      tags: [...obs.tags],
      json: JSON.parse(JSON.stringify({ a: [1, { b: 2 }] })),
      latestRound: latest.round,
      calls: state.calls,
    };
  `);
  assert.ok(r.ok, r.ok ? "" : r.reason);
  const logs: unknown[] = [];
  const ctx = { ...(hostContext() as object), log: (e: unknown) => logs.push(e) } as never;
  assert.deepEqual(await r.executor(observation() as never, ctx), {
    type: "noop",
    caught: "StrategyError:too thin:true:true",
    book: "book(1)",
    size: 124n,
    tag: "tagged",
    sorted: [2, 1],
    ratio: 2,
    when: "1970-01-01T00:00:00.000Z",
    byToken: { WETH: { price: 3000 } },
    tags: ["a"],
    json: { a: [1, { b: 2 }] },
    latestRound: 7,
    calls: 1,
  });
  assert.deepEqual(logs, [{ reason: "sized", signals: { book: "book(1)", tag: "tagged" } }]);
  // The same in strict mode, where a refused assignment throws instead of doing nothing.
  const strict = compileExecutor(`"use strict";
    class E extends TypeError { constructor() { super("m"); this.name = "E"; this.message = "set"; } }
    const o = {}; o.toString = () => "o"; o.constructor = "c";
    const f = function () {}; f.toString = () => "f";
    const e = new E();
    return { type: "noop", e: e.name + ":" + e.message, o: String(o) + o.constructor, f: String(f) };
  `);
  assert.ok(strict.ok, strict.ok ? "" : strict.reason);
  assert.deepEqual(await strict.executor({ round: 1 } as never, hostContext()), {
    type: "noop",
    e: "E:set",
    o: "oc",
    f: "f",
  });
});

test("lockdown: data keyed by a built-in's name is copied as data", async () => {
  // Registry and token symbols come from the chain, so a key can be anything. Assigned into a copy,
  // "hasOwnProperty" would hit the frozen Object.prototype and make every copy throw, and
  // "__proto__" would set the copy's prototype rather than a key.
  const byToken = JSON.parse(
    '{"hasOwnProperty":1,"toString":2,"constructor":3,"__proto__":{"x":4},"WETH":5}',
  );
  const r = compileExecutor(`
    const b = obs.byToken;
    return {
      type: "noop",
      keys: Object.keys(b),
      plain: Object.getPrototypeOf(b) === Object.prototype,
      values: [b.hasOwnProperty, b.toString, b.constructor, b.__proto__.x, b.WETH],
    };
  `);
  assert.ok(r.ok, r.ok ? "" : r.reason);
  assert.deepEqual(await r.executor({ round: 1, byToken } as never, hostContext()), {
    type: "noop",
    keys: ["hasOwnProperty", "toString", "constructor", "__proto__", "WETH"],
    plain: true,
    values: [1, 2, 3, 4, 5],
  });
});

test("lockdown: a host error raised at the stack limit comes back as a copy", async (t) => {
  // Reading a host value runs host code (the client's proxy trap, a host method), and an error that
  // code throws is a host object. Generated code chooses how deep the stack is when it calls in, so
  // it can make the host frame the one that overflows: recurse to the limit, then touch every entry
  // point on the way back up.
  withMarker(t);
  const r = compileExecutor(`
    const hostErrors = [];
    let probes = 0;
    const touch = [
      () => ctx.publicClient.getBlockNumber,
      () => ctx.publicClient.chain,
      () => "chain" in ctx.publicClient,
      () => ctx.latestObservation(),
      () => ctx.log({ a: 1 }),
      () => ctx.submit({ type: "noop" }),
    ];
    // One descent per entry point: the frame that overflows has to be the host's, and which one
    // that is depends on what else runs at each level.
    const dive = (i) => {
      try { dive(i); } catch (e) {}
      try { touch[i](); } catch (e) {
        probes++;
        if (!(e instanceof Error)) hostErrors[hostErrors.length] = e;
      }
    };
    for (let i = 0; i < touch.length; i++) dive(i);
    let reached = "";
    for (let i = 0; i < hostErrors.length; i++) {
      try { reached += String(hostErrors[i].constructor.constructor("return process")().env.${MARKER_NAME}); } catch (e) {}
    }
    return { type: "noop", hostErrors: hostErrors.length, probes, reached };
  `);
  assert.ok(r.ok, r.ok ? "" : r.reason);
  // The client the bridge sees in production is a Proxy over viem's (hostReadClient), so a property
  // read runs a host trap; this one does too.
  const out = (await r.executor(observation() as never, hostContext())) as unknown as {
    hostErrors: number;
    probes: number;
    reached: string;
  };
  assert.ok(out.probes > 0, "the probe never reached the stack limit");
  assert.equal(out.reached, "");
  assert.equal(out.hostErrors, 0);
});

test("compileExecutor: the body cannot close the wrapper around it", async (t) => {
  withMarker(t);
  // Nothing in the source runs at compile time. The parent process compiles every revision to
  // validate it, and the parent holds the wallet key in its environment.
  const topLevel = compileExecutor(`}); throw new Error("ran at compile time"); (function () {`);
  assert.ok(topLevel.ok || !/ran at compile time/.test(topLevel.reason), "the body ran at compile time");
  // A value the host calls is never one the strategy made: a callable Proxy's apply trap is handed
  // an arguments array from the realm that calls it.
  const proxied = compileExecutor(`});
    var trap = new Proxy(function () {}, { apply(target, self, args) {
      return { type: "noop", reached: String(args.constructor.constructor("return process")().env.${MARKER_NAME}) };
    } });
    (trap || function () {`);
  let outcome = "";
  if (proxied.ok) {
    try {
      outcome = JSON.stringify(await proxied.executor({ round: 1 } as never, hostContext()));
    } catch (error) {
      outcome = String((error as Error).message);
    }
  }
  assert.ok(!outcome.includes(MARKER), outcome);
});

// A dynamic import() compiles and rejects, with an error of Node's realm: in this process that error
// reaches `process`, which is why generated code never runs here but in a child process under Node's
// permission model (strategyRunner.ts; test/strategyRunner.test.ts tries the escape there). What the
// context still refuses is building code from strings.
test("compileExecutor: import() compiles and fails, import.meta does not compile, and no code is built from strings", async (t) => {
  withMarker(t);
  const dynamic = compileExecutor(`return import("node:fs").then(() => "loaded", () => "failed");`);
  assert.ok(dynamic.ok, dynamic.ok ? "" : dynamic.reason);
  assert.equal(await dynamic.executor({ round: 1 } as never, hostContext()), "failed");
  const meta = compileExecutor(`return import.meta;`);
  assert.ok(!meta.ok);
  assert.match(meta.reason, /compile failed/);
  const spelled = `["imp", "ort('node:fs')"].join("")`;
  for (const source of [
    `try { await eval(${spelled}); } catch (e) { return { type: "noop", r: String(e.constructor.constructor("return process")().env.${MARKER_NAME}) }; }`,
    `try { await Function("return " + ${spelled})(); } catch (e) { return { type: "noop", r: String(e.constructor.constructor("return process")().env.${MARKER_NAME}) }; }`,
    `try { await (async () => {}).constructor("return " + ${spelled})(); } catch (e) { return { type: "noop", r: String(e.constructor.constructor("return process")().env.${MARKER_NAME}) }; }`,
  ]) {
    const r = compileExecutor(source);
    assert.ok(r.ok, r.ok ? "" : r.reason);
    let outcome: string;
    try {
      outcome = JSON.stringify(await r.executor({ round: 1 } as never, hostContext()));
    } catch (error) {
      outcome = String((error as Error).message);
    }
    assert.ok(!outcome.includes(MARKER), `${source} -> ${outcome}`);
    assert.match(outcome, /Code generation from strings disallowed/);
  }
});

test("compileExecutor: the word import is code like any other", async () => {
  for (const [source, expected] of [
    [`// import the price from the feed\nreturn 1;`, 1],
    [`/* import */ return 2;`, 2],
    [`ctx.log({ reason: "import failed" }); return "import".length;`, 6],
    [`return obs.import;`, 7],
    [`return obs?.import;`, 7],
    [`const o = { import: 3 }; return o.import + obs["import"];`, 10],
    [`const o = { import() { return 4; } }; return o.import();`, 4],
    [`return "import(x)".length;`, 9],
  ] as const) {
    const r = compileExecutor(source);
    assert.ok(r.ok, `${source}: ${r.ok ? "" : r.reason}`);
    const v = await r.executor({ round: 1, import: 7 } as never, hostContext());
    assert.equal(v, expected, source);
  }
});

test("lockdown: WebAssembly's streaming functions cannot hand over an error of the host's realm", async (t) => {
  withMarker(t);
  // Node, not the engine, answers compileStreaming / instantiateStreaming, and it rejects a source
  // that is not a Response with an error it creates in its own realm: that error's
  // `constructor.constructor` was the host's Function. The namespace is removed and wasm code
  // generation is off in the context.
  const r = compileExecutor(`
    let reached = "";
    const calls = [
      () => WebAssembly.compileStreaming(1),
      () => WebAssembly.instantiateStreaming(1),
      () => globalThis.WebAssembly.compileStreaming({ then(ok) { ok(1); } }),
    ];
    for (let i = 0; i < calls.length; i++) {
      try { await calls[i](); } catch (e) {
        try { reached += String(e.constructor.constructor("return process")().env.${MARKER_NAME}); } catch (x) {}
      }
    }
    return { type: "noop", reached, round: obs.round, latest: ctx.latestObservation().round };
  `);
  assert.ok(r.ok, r.ok ? "" : r.reason);
  assert.deepEqual(await r.executor(observation() as never, hostContext()), {
    type: "noop",
    reached: "",
    round: 7,
    latest: 7,
  });
});

test("lockdown: WebAssembly, Symbol.for and Symbol.keyFor are not in the context", async () => {
  // Symbol.for is the only way to a registered symbol, and Node reads one off arbitrary objects:
  // util.inspect calls `obj[Symbol.for("nodejs.util.inspect.custom")]` with the host's inspect as an
  // argument. Without Symbol.for no value generated code makes can carry it.
  const r = compileExecutor(`
    "use strict";
    return {
      type: "noop",
      wasm: typeof WebAssembly + ":" + ("WebAssembly" in globalThis),
      symbolFor: typeof Symbol.for + ":" + (Object.getOwnPropertyDescriptor(Symbol, "for") === undefined),
      keyFor: typeof Symbol.keyFor + ":" + ("keyFor" in Symbol),
      // The rest of Symbol is still there, and still frozen.
      symbols: typeof Symbol("x") + ":" + (Symbol.iterator in []) + ":" + Object.isFrozen(Symbol),
    };
  `);
  assert.ok(r.ok, r.ok ? "" : r.reason);
  assert.deepEqual(await r.executor({ round: 1 } as never, hostContext()), {
    type: "noop",
    wasm: "undefined:false",
    symbolFor: "undefined:true",
    keyFor: "undefined:false",
    symbols: "symbol:true:true",
  });
  // And what is not there cannot be put back.
  const restore = compileExecutor(`"use strict"; Symbol.for = () => 1; return null;`);
  assert.ok(restore.ok);
  await assert.rejects(
    async () => await restore.executor({ round: 1 } as never, hostContext()),
    /not extensible/,
  );
});

test("compileExecutor: what a strategy throws reaches the host as text, never as a value of the vm", async () => {
  // A thrown value's toString, getters and prototype chain are the strategy's code. If the host
  // stringifies it, what that code throws in turn is a value of the vm loose in the host, outside
  // every try -- in the worker an unhandled rejection, which Node hands to util.inspect. So the
  // bridge turns the throw into a string in the vm, and the executor rejects with an Error of this
  // realm.
  const cases: [string, string | RegExp][] = [
    [`throw new Error("boom");`, "Error: boom"],
    [`throw "plain";`, "plain"],
    [`class E extends Error { constructor() { super("m"); this.name = "E"; } } throw new E();`, "E: m"],
    [
      `throw { toString() { throw { toString() { throw new Error("again"); } }; } };`,
      "the strategy threw a value that could not be turned into text",
    ],
    [
      `throw new Proxy({}, { get() { throw { stack: "s" }; }, getPrototypeOf() { throw 1; } });`,
      "the strategy threw a value that could not be turned into text",
    ],
    // The return value is cloned into this realm, and the clone runs its getters.
    [
      `const o = { type: "noop" };
       Object.defineProperty(o, "x", { enumerable: true, get() { throw { toString() { throw 1; } }; } });
       return o;`,
      "the executor's return value is not plain data: a getter of it threw",
    ],
    [
      `const o = { type: "noop" };
       Object.defineProperty(o, "x", { enumerable: true, get() { throw { toString() { throw 1; } }; } });
       try { ctx.submit(o); } catch (e) { return { type: "noop", submit: e.message }; }
       return null;`,
      "",
    ],
  ];
  for (const [source, expected] of cases) {
    const r = compileExecutor(source);
    assert.ok(r.ok, r.ok ? "" : r.reason);
    let outcome: unknown;
    try {
      outcome = await r.executor({ round: 1 } as never, hostContext());
    } catch (error) {
      assert.ok(error instanceof Error, `${source}: rejected with a value of the vm`);
      if (expected instanceof RegExp) assert.match(error.message, expected, source);
      else assert.equal(error.message, expected, source);
      continue;
    }
    // The submit case: the host's refusal comes back to the strategy as a copy, as text.
    assert.equal(expected, "", `${source} did not throw`);
    assert.deepEqual(outcome, {
      type: "noop",
      submit: "a submitted action is not plain data: a getter of it threw",
    });
  }
});
