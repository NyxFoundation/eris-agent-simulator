// Indirection point: swap this export to point at a remote provider later
// without touching any component that consumes the data layer.
export {
  fetchTopPageSnapshot,
  fetchExplorerSnapshot,
  fetchMarketSnapshot,
  fetchArchiveSnapshot,
  fetchAgentDetailSnapshot,
} from "./localProvider";
