// Derive metric-comparison regimes from the official ones (ADR 0020 §4 re-comparison in scenario
// mode). The official regimes stay untouched: they define the competition, and their funding was
// calibrated for netPnlUsdc, which nets out the common ETH endowment. An epoch series is a live
// mark, so the same endowment would put ETH's volatility into every agent's std (ADR 0019 §6).
import { readFileSync, writeFileSync } from "node:fs";
import { parse, stringify } from "yaml";

const REGIMES = ["calm", "cex-drift", "informed-flow", "whale", "lending-incident", "crash", "depeg"];

for (const r of REGIMES) {
  const src = `config/regimes/${r}.yaml`;
  const doc = parse(readFileSync(src, "utf8")) as Record<string, any>;
  doc.run = {
    ...(doc.run ?? {}),
    economicGas: true, // ADR 0011: gas is a real cost against the 1 ETH reserve
    epochBlocks: 12, // ADR 0019 §8
    markMedianBlocks: 5, // G7's window, ending at the boundary
  };
  doc.funding = {
    ...(doc.funding ?? {}),
    ethWei: "1000000000000000000", // 1 ETH, gas reserve only (the buffer is folded in for agents)
    wethWei: "0", // USDC-only, as ADR 0019 §6 decided
    usdcUnits: "100000000000", // 100,000 USDC
  };
  const header =
    `# config/regimes/metric-${r}.yaml — AUTO-GENERATED from config/regimes/${r}.yaml.\n` +
    `#\n` +
    `# Same market conditions, ADR 0019 §6 funding (1 ETH gas reserve + 100k USDC, economicGas). The\n` +
    `# official regime hands out 100 ETH, which is 92.2% of an agent's portfolio by value: netPnlUsdc\n` +
    `# nets that out (both ends are priced at the final price) but an epoch series marks it live, so\n` +
    `# every agent's std_e would be ETH's volatility and M9's lambda term would measure the market\n` +
    `# rather than the agent. Used only to compare M4 / M9 / M27 in scenario mode (ADR 0020 §4); the\n` +
    `# competition's own regimes are the files this was generated from.\n` +
    `#\n` +
    `# Known cost of USDC-only: lp-provider cannot mint an LP position at all (measured: 21 of 24\n` +
    `# rounds "insufficient LP budget"), so the one inventory-holding strategy sits the comparison out.\n`;
  writeFileSync(`config/regimes/metric-${r}.yaml`, header + stringify(doc));
  console.log(`wrote config/regimes/metric-${r}.yaml`);
}
