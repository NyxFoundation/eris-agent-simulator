// @eris/sdk の公開面（ADR 0015）。
// 参加者（example/agents）はまずここから import する。深い個別モジュール
// （@eris/sdk/protocols/uniswap.js 等）へのサブパス import も可能（package exports 参照）。
export * from "./types.js";
export type {
  AgentContext,
  AgentLogEntry,
  AgentModule,
  AgentRuntimeConfig,
  DecideFn,
  RunFn,
} from "./agent.js";
export { parseAction, validateAction } from "./action.js";
export type {
  ActionValidation,
  ValidatedIntent,
  ValidatedRawIntent,
} from "./action.js";
export {
  actionJsonSchema,
  agentActionSchema,
  agentActionSchemaFor,
} from "./actionSchema.js";
export { loadConfig, type SimConfig } from "./config.js";
export { loadYamlConfig } from "./runConfig.js";
export { observationFor } from "./observation.js";
export { readFairPrice, readFairPriceFor, priceFeedAbi } from "./priceFeed.js";
export { getBalances, makeClients, accountAddress } from "./chain.js";
export { initProtocols, enabledAdapters } from "./protocols/registry.js";
export type {
  ProtocolAdapter,
  SimContext,
  BuiltTx,
} from "./protocols/types.js";
export { safeStringify } from "./logger.js";
export { Rng } from "./rng.js";
