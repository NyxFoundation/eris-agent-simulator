// Indirection point: components consume the data layer only through these
// exports. The default provider reads real run artifacts (runs/<id>/, served by
// the Vite dev server — issue #63 Phase 1); start with VITE_DATA_PROVIDER=seed
// to fall back to the IndexedDB seed provider for UI development.
import * as seedProvider from "./localProvider";
import * as runsProvider from "./runsProvider";

export const isSeedProvider = import.meta.env.VITE_DATA_PROVIDER === "seed";

const provider = isSeedProvider ? seedProvider : runsProvider;

export const {
  fetchTopPageSnapshot,
  fetchExplorerSnapshot,
  fetchMarketSnapshot,
  fetchAgentDetailSnapshot,
} = provider;
