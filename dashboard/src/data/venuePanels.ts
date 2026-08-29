// The /markets page's venue panels: what each deployed application is doing, per run.
//
// The AMM quotes and depth, GMX open interest and funding, the Aave reserve totals and the
// market-priced stables all come from runs/<id>/market.json (the post-run reconstruction). The LST
// vault and the Liquity system are emitted per block by the coordinator into events.jsonl
// (lst_block / liquity_block), so they are read from there — which also means those two panels
// work for runs recorded before market.json grew the fields.
//
// A panel is data, not layout: the page renders stats, charts and tables generically, and every
// decision about what a venue's state *is* is made here.

import type { LoadedRun } from "./runArtifacts";
import {
  blockSeriesOf,
  downsample,
  enabledProtocols,
  eventOfType,
  eventsOfType,
  formatBaseUnits,
  formatBps,
  formatPercent,
  formatUsd,
  fromWei,
  num,
  seriesColor,
  seriesOf,
  shortAddress,
  stableSymbols,
  str,
  VENUE_COLORS,
  VENUE_LABELS,
  type TxInfo,
} from "./artifactHelpers";
import type {
  ArbitrageSnapshot,
  SeriesLine,
  SeriesPoint,
  VenueChart,
  VenueDepthView,
  VenuePanel,
  VenueStat,
  VenueTable,
  VenueTableCell,
} from "./types";

// ---------------------------------------------------------------------------
// venue panels (the /markets page)

const cell = (text: string, tone?: VenueTableCell["tone"]): VenueTableCell =>
  tone ? { text, tone } : { text };

function lineFrom(
  id: string,
  label: string,
  color: string,
  points: SeriesPoint[],
  dashed = false,
): SeriesLine | null {
  const kept = downsample(
    points.filter((p) => Number.isFinite(p.value)),
    720,
  );
  if (kept.length < 2) return null;
  return { id, label, color, points: kept, ...(dashed ? { dashed } : {}) };
}

function chartFrom(
  id: string,
  title: string,
  unit: VenueChart["unit"],
  lines: (SeriesLine | null)[],
  reference?: { value: number; label: string },
): VenueChart | null {
  const kept = lines.filter((l): l is SeriesLine => l !== null);
  if (kept.length === 0) return null;
  return {
    id,
    title,
    unit,
    lines: kept,
    ...(reference ? { reference } : {}),
  };
}

function buildAmmPanel(
  run: LoadedRun,
  base: string,
  arbitrage: ArbitrageSnapshot,
  depths: VenueDepthView[],
  swaps: VenueTable,
): VenuePanel {
  const market = run.market;
  const protocols = enabledProtocols(run).filter((p) =>
    ["uniswap", "balancer", "curve"].includes(p),
  );
  const stats: VenueStat[] = [];
  const charts: (VenueChart | null)[] = [];
  const tables: VenueTable[] = [];

  const spreads = arbitrage.spread.map((s) => s.spreadBps);
  if (spreads.length > 0) {
    const widest = Math.max(...spreads);
    const above = spreads.filter((s) => s > arbitrage.thresholdBps).length;
    stats.push({
      label: "Widest cross-venue gap",
      value: formatBps(widest),
      tone: widest > arbitrage.thresholdBps ? "up" : "neutral",
      sub: `threshold ${arbitrage.thresholdBps}bps round-trip`,
    });
    stats.push({
      label: "Blocks above threshold",
      value: `${above} / ${spreads.length}`,
      tone: above > 0 ? "warn" : "neutral",
      sub: formatPercent((above / spreads.length) * 100),
    });
  }

  if (market) {
    const lastRow = market.series[market.series.length - 1];
    const firstRow = market.series[0];
    const depthAt = (row: typeof lastRow | undefined): number =>
      row
        ? market.venues.reduce(
            (sum, v) => sum + (row.venues?.[v]?.[base]?.depthUsd ?? 0),
            0,
          )
        : 0;
    const now = depthAt(lastRow);
    const start = depthAt(firstRow);
    if (now > 0) {
      stats.push({
        label: "Pool depth (all venues)",
        value: formatUsd(now),
        tone: now < start ? "down" : "neutral",
        sub: `start ${formatUsd(start)}`,
      });
    }

    // Traded volume in the base. priceUsd is the discriminator: it exists only when both legs
    // moved, so one-sided transfers (Aave supplies, GMX collateral) stay out of traded volume.
    let volume = 0;
    let swapCount = 0;
    for (const notional of Object.values(market.notionals)) {
      if (notional.base === base && notional.priceUsd !== undefined) {
        volume += notional.usd;
        swapCount++;
      }
    }
    if (volume > 0) {
      stats.push({
        label: `Swap volume · ${base}`,
        value: formatUsd(volume),
        sub: `${swapCount.toLocaleString("en-US")} swaps`,
      });
    }

    charts.push(
      chartFrom(
        "amm-depth",
        `Pool depth · ${base}`,
        "usd",
        market.venues.map((venue) =>
          lineFrom(
            venue,
            VENUE_LABELS[venue] ?? venue,
            VENUE_COLORS[venue] ?? seriesColor(0),
            market.series.flatMap((r) => {
              const depth = r.venues?.[venue]?.[base]?.depthUsd;
              return depth !== undefined
                ? [{ time: r.block, value: depth }]
                : [];
            }),
          ),
        ),
      ),
    );

    if (lastRow) {
      const rows = market.venues.flatMap((venue) => {
        const sample = lastRow.venues?.[venue]?.[base];
        if (!sample) return [];
        return [
          [
            cell(VENUE_LABELS[venue] ?? venue, "link"),
            cell(formatUsd(sample.mid)),
            cell(
              sample.sell !== undefined ? formatUsd(sample.sell) : "—",
              "down",
            ),
            cell(sample.buy !== undefined ? formatUsd(sample.buy) : "—", "up"),
            cell(
              sample.depthUsd !== undefined ? formatUsd(sample.depthUsd) : "—",
            ),
          ],
        ];
      });
      tables.push({
        id: "amm-quotes",
        title: `Executable quotes at the final block · ${base}`,
        columns: [
          { label: "Venue" },
          { label: "Mid", align: "right" },
          { label: "Sell", align: "right" },
          { label: "Buy", align: "right" },
          { label: "Depth", align: "right" },
        ],
        rows,
        empty: "no venue quotes in this run's market series",
      });
    }
  }

  tables.push(swaps);

  return {
    id: "amm",
    label: "AMM",
    protocols,
    caption:
      "Three constant-function venues quote the same pair. Depth is what a liquidity pull moves; the gap between venues is what an arbitrageur is paid to close, once it clears the round-trip cost.",
    stats,
    charts: charts.filter((c): c is VenueChart => c !== null),
    tables,
    ...(depths.length === 0 && !market
      ? { note: "per-venue depth appears once the run completes (market.json)" }
      : {}),
  };
}

function buildPerpPanel(run: LoadedRun, base: string): VenuePanel {
  const market = run.market;
  const stats: VenueStat[] = [];
  const charts: (VenueChart | null)[] = [];
  const tables: VenueTable[] = [];
  const rowsWithGmx = (market?.series ?? []).filter((r) => r.gmx?.[base]);
  const lastGmx = rowsWithGmx[rowsWithGmx.length - 1]?.gmx?.[base];

  if (lastGmx) {
    const total = lastGmx.longOiUsd + lastGmx.shortOiUsd;
    stats.push({
      label: "Open interest",
      value: formatUsd(total),
      sub:
        total > 0
          ? `${Math.round((lastGmx.longOiUsd / total) * 100)}% long / ${Math.round((lastGmx.shortOiUsd / total) * 100)}% short`
          : "no open interest",
    });
    stats.push({
      label: "Long OI",
      value: formatUsd(lastGmx.longOiUsd),
      tone: "up",
    });
    stats.push({
      label: "Short OI",
      value: formatUsd(lastGmx.shortOiUsd),
      tone: "down",
    });
    stats.push({
      label: "Funding / 1h",
      // absent = the funding read failed for that sample; "n/a" is honest, 0.00bps is not
      value:
        lastGmx.fundingPerHourBps !== undefined
          ? `${lastGmx.fundingPerHourBps.toFixed(3)}bps`
          : "n/a",
      sub: "positive = longs pay shorts",
    });

    charts.push(
      chartFrom("gmx-oi", `Open interest · ${base}`, "usd", [
        lineFrom(
          "long",
          "Long",
          "#4fd1a5",
          rowsWithGmx.map((r) => ({
            time: r.block,
            value: r.gmx?.[base]?.longOiUsd ?? 0,
          })),
        ),
        lineFrom(
          "short",
          "Short",
          "#e879a6",
          rowsWithGmx.map((r) => ({
            time: r.block,
            value: r.gmx?.[base]?.shortOiUsd ?? 0,
          })),
        ),
      ]),
    );
    charts.push(
      chartFrom(
        "gmx-funding",
        "Funding rate per hour",
        "bps",
        [
          lineFrom(
            "funding",
            "Funding",
            "#f5a623",
            rowsWithGmx.flatMap((r) => {
              const value = r.gmx?.[base]?.fundingPerHourBps;
              return value !== undefined ? [{ time: r.block, value }] : [];
            }),
          ),
        ],
        { value: 0, label: "balanced" },
      ),
    );
  }

  const positions = (market?.gmxPositionsAtEnd ?? []).filter(
    (p) => p.base === base,
  );
  const lastFair =
    market?.series[market.series.length - 1]?.fair[base] ??
    run.summary.finalFairPriceUsdcPerWeth ??
    0;
  tables.push({
    id: "gmx-positions",
    title: "Positions open at the run's final block",
    columns: [
      { label: "Agent" },
      { label: "Side" },
      { label: "Size", align: "right" },
      { label: "Collateral", align: "right" },
      { label: "Entry", align: "right" },
      { label: "PnL", align: "right" },
    ],
    rows: positions.map((p) => {
      const pnlPercent =
        p.entryPriceUsd && p.entryPriceUsd > 0 && lastFair > 0
          ? (lastFair / p.entryPriceUsd - 1) * 100 * (p.isLong ? 1 : -1)
          : 0;
      return [
        cell(p.agent, "link"),
        cell(p.isLong ? "LONG" : "SHORT", p.isLong ? "up" : "down"),
        cell(formatUsd(p.sizeUsd)),
        cell(formatUsd(p.collateralUsd)),
        cell(
          p.entryPriceUsd
            ? p.entryPriceUsd.toLocaleString("en-US", {
                maximumFractionDigits: 1,
              })
            : "—",
        ),
        cell(
          `${pnlPercent >= 0 ? "+" : ""}${pnlPercent.toFixed(1)}%`,
          pnlPercent >= 0 ? "up" : "down",
        ),
      ];
    }),
    empty: "no perp position was open when the run ended",
  });

  const keeperFailures = eventsOfType(run.events, "keeper_failed").length;
  if (keeperFailures > 0) {
    stats.push({
      label: "Keeper failures",
      value: String(keeperFailures),
      tone: "warn",
      sub: "orders the environment's keeper could not execute",
    });
  }

  return {
    id: "perp",
    label: "Perp",
    protocols: ["gmx"],
    caption:
      "GMX v2. Positions are opened as orders and executed by the environment's keeper a block later, so a perp trade always lands one block after the decision that produced it. Funding is what the crowded side pays the other.",
    stats,
    charts: charts.filter((c): c is VenueChart => c !== null),
    tables,
    ...(lastGmx
      ? {}
      : {
          note: market
            ? `no GMX state recorded for ${base} in this run`
            : "GMX state appears once the run completes (market.json)",
        }),
  };
}

function buildLendingPanel(run: LoadedRun): VenuePanel {
  const market = run.market;
  const stats: VenueStat[] = [];
  const charts: (VenueChart | null)[] = [];
  const tables: VenueTable[] = [];

  const rowsWithAave = (market?.series ?? []).filter((r) => r.aave);
  const lastAave = rowsWithAave[rowsWithAave.length - 1]?.aave;
  const assets = lastAave ? Object.keys(lastAave) : [];

  if (lastAave) {
    const supplied = assets.reduce(
      (sum, a) => sum + (lastAave[a]?.suppliedUsd ?? 0),
      0,
    );
    const borrowed = assets.reduce(
      (sum, a) => sum + (lastAave[a]?.borrowedUsd ?? 0),
      0,
    );
    stats.push({ label: "Total supplied", value: formatUsd(supplied) });
    stats.push({
      label: "Total borrowed",
      value: formatUsd(borrowed),
      sub:
        supplied > 0
          ? `utilization ${formatPercent((borrowed / supplied) * 100, 2)}`
          : undefined,
    });

    charts.push(
      chartFrom(
        "aave-borrowed",
        "Borrowed by reserve",
        "usd",
        assets.map((asset, i) =>
          lineFrom(
            asset,
            asset,
            seriesColor(i),
            rowsWithAave.map((r) => ({
              time: r.block,
              value: r.aave?.[asset]?.borrowedUsd ?? 0,
            })),
          ),
        ),
      ),
    );
    charts.push(
      chartFrom(
        "aave-utilization",
        "Utilization by reserve",
        "percent",
        assets.map((asset, i) =>
          lineFrom(
            asset,
            asset,
            seriesColor(i),
            rowsWithAave.map((r) => ({
              time: r.block,
              value: (r.aave?.[asset]?.utilization ?? 0) * 100,
            })),
          ),
        ),
      ),
    );

    tables.push({
      id: "aave-reserves",
      title: "Reserves at the run's final block",
      columns: [
        { label: "Asset" },
        { label: "Supplied", align: "right" },
        { label: "Borrowed", align: "right" },
        { label: "Utilization", align: "right" },
      ],
      rows: assets.map((asset) => [
        cell(asset, "link"),
        cell(formatUsd(lastAave[asset].suppliedUsd)),
        cell(formatUsd(lastAave[asset].borrowedUsd)),
        cell(formatPercent(lastAave[asset].utilization * 100, 2)),
      ]),
      empty: "no Aave reserve totals in this run's market series",
    });
  }

  // The seeded victims (ADR 0009) are what makes a liquidation reachable; their health factor is
  // the line an agent is watching. Reported as the worst victim per block.
  const victimEvents = blockSeriesOf(run, "stress_victim_hf");
  const victimHf: SeriesPoint[] = victimEvents.flatMap((e) => {
    const victims =
      (e.victims as { healthFactor?: string }[] | undefined) ?? [];
    const values = victims
      .map((v) => Number(v.healthFactor ?? 0) / 1e18)
      .filter((v) => Number.isFinite(v) && v > 0);
    return values.length > 0
      ? [{ time: Number(e.blockNumber), value: Math.min(...values) }]
      : [];
  });
  if (victimHf.length > 0) {
    const worst = Math.min(...victimHf.map((p) => p.value));
    stats.push({
      label: "Worst victim health factor",
      value: worst.toFixed(3),
      tone: worst < 1 ? "down" : "neutral",
      sub: worst < 1 ? "liquidatable" : "above the liquidation line",
    });
    charts.push(
      chartFrom(
        "aave-victim-hf",
        "Seeded victim health factor (worst)",
        "ratio",
        [lineFrom("hf", "Min HF", "#e879a6", victimHf)],
        { value: 1, label: "liquidation" },
      ),
    );
  }

  const liquidations = blockSeriesOf(run, "stress_liquidation");
  if (liquidations.length > 0) {
    stats.push({
      label: "Liquidations",
      value: String(liquidations.length),
      tone: "down",
    });
  }
  tables.push({
    id: "aave-liquidations",
    title: "Liquidations",
    columns: [
      { label: "Block" },
      { label: "Victim" },
      { label: "Health factor", align: "right" },
      { label: "Remaining debt", align: "right" },
    ],
    rows: liquidations.slice(-24).map((e) => [
      cell(Number(e.blockNumber).toLocaleString("en-US")),
      cell(str(e.victimId), "link"),
      cell((Number(e.healthFactor ?? 0) / 1e18).toFixed(3), "down"),
      // Aave base units are 8-decimal USD.
      cell(formatUsd((fromWei(e.remainingDebtBase, 8) ?? 0) as number)),
    ]),
    empty: "no victim was liquidated in this run",
  });

  const accounts = market?.aaveAccountsAtEnd ?? [];
  tables.push({
    id: "aave-accounts",
    title: "Agent accounts at the run's final block",
    columns: [
      { label: "Agent" },
      { label: "Collateral", align: "right" },
      { label: "Debt", align: "right" },
      { label: "Health factor", align: "right" },
    ],
    rows: accounts.map((a) => [
      cell(a.agent, "link"),
      cell(formatUsd(a.collateralUsd)),
      cell(formatUsd(a.debtUsd)),
      cell(
        a.healthFactor === null ? "∞" : a.healthFactor.toFixed(3),
        a.healthFactor !== null && a.healthFactor < 1.1 ? "down" : "neutral",
      ),
    ]),
    empty: "no agent held an Aave position when the run ended",
  });

  return {
    id: "lending",
    label: "Lending",
    protocols: ["aave"],
    caption:
      "Aave v3. The oracle the pool prices collateral with is written by the environment and lands one block late, so a health factor an agent reads is always a block behind the price that will break it.",
    stats,
    charts: charts.filter((c): c is VenueChart => c !== null),
    tables,
    ...(lastAave
      ? {}
      : {
          note: market
            ? "no Aave reserve state recorded in this run"
            : "Aave state appears once the run completes (market.json)",
        }),
  };
}

function buildStablePanel(run: LoadedRun): VenuePanel {
  const market = run.market;
  const stats: VenueStat[] = [];
  const charts: (VenueChart | null)[] = [];
  const tables: VenueTable[] = [];
  const protocols = enabledProtocols(run).filter((p) =>
    ["liquity", "curve"].includes(p),
  );

  // --- market-priced stables (issue #27): the price is a measurement, never a $1 axiom ---
  const symbols = market ? stableSymbols(market) : [];
  const priceLines = symbols.map((symbol, i) =>
    lineFrom(
      symbol,
      symbol,
      seriesColor(i),
      (market?.series ?? []).flatMap((r) => {
        const sample = r.stables?.[symbol];
        // An unquoted probe is par by fallback, not an observation — charting it as a price would
        // draw a flat peg the pool never confirmed.
        return sample?.quoted
          ? [{ time: r.block, value: sample.priceUsdc }]
          : [];
      }),
    ),
  );

  for (const symbol of symbols) {
    const rows = (market?.series ?? []).flatMap((r) => {
      const sample = r.stables?.[symbol];
      return sample ? [sample] : [];
    });
    const last = rows[rows.length - 1];
    if (!last) continue;
    const lowest = Math.min(
      ...rows.filter((r) => r.quoted).map((r) => r.priceUsdc),
    );
    stats.push({
      label: `${symbol} price`,
      value: last.priceUsdc.toFixed(4),
      tone: last.priceUsdc < 0.999 ? "down" : "neutral",
      sub: last.quoted
        ? `deepest ${Number.isFinite(lowest) ? lowest.toFixed(4) : "—"} · ${formatBps((last.priceUsdc - 1) * 10_000)} vs par`
        : "pool would not quote — par by fallback",
    });
  }

  // --- Liquity: the CDP's own state, emitted every block by the coordinator ---
  const liquityBlocks = blockSeriesOf(run, "liquity_block");
  const lastLiquity = liquityBlocks[liquityBlocks.length - 1];
  if (lastLiquity) {
    const tcr = Number(lastLiquity.tcr);
    const debt = fromWei(lastLiquity.totalDebtEusdWei) ?? 0;
    const sp = fromWei(lastLiquity.stabilityPoolEusdWei) ?? 0;
    stats.push({
      label: "System TCR",
      value: tcr.toFixed(3),
      tone: tcr < 1.5 ? "down" : "neutral",
      sub: lastLiquity.recoveryMode ? "RECOVERY MODE" : "above CCR (1.5)",
    });
    stats.push({
      label: "Troves open",
      value: String(num(lastLiquity.troveCount)),
      sub: `riskiest ICR ${Number(lastLiquity.riskiestIcr ?? 0).toFixed(3)}`,
    });
    stats.push({
      label: "eUSD debt",
      value: `${debt.toLocaleString("en-US", { maximumFractionDigits: 0 })}`,
      sub: `stability pool ${sp.toLocaleString("en-US", { maximumFractionDigits: 0 })} eUSD`,
    });
    stats.push({
      label: "Redemption fee",
      value: `${num(lastLiquity.redemptionRateBps).toFixed(1)}bps`,
      sub: `borrowing ${num(lastLiquity.borrowingRateBps).toFixed(1)}bps`,
    });
    // The peg itself, from the venue's own read — so the number is here for runs recorded before
    // market.json carried a stables field, not only for the ones that do.
    if (!symbols.includes("EUSD")) {
      const price = num(lastLiquity.marketPriceUsdc);
      const deepest = Math.min(
        ...liquityBlocks
          .map((e) => num(e.marketPriceUsdc))
          .filter((p) => p > 0),
      );
      stats.unshift({
        label: "eUSD price",
        value: price.toFixed(4),
        tone: price < 0.999 ? "down" : "neutral",
        sub: `deepest ${Number.isFinite(deepest) ? deepest.toFixed(4) : "—"} · ${formatBps(num(lastLiquity.discountBps) * -1)} vs par`,
      });
    }

    // The eUSD peg from the venue's own per-block read. It is the same pool the market-priced
    // stable probe uses, but recorded live rather than reconstructed — so it exists for runs that
    // predate the stables field in market.json.
    if (priceLines.every((l) => l === null || l.id !== "EUSD")) {
      priceLines.push(
        lineFrom(
          "EUSD",
          "eUSD (venue read)",
          seriesColor(symbols.length),
          seriesOf(liquityBlocks, "marketPriceUsdc"),
        ),
      );
    }

    charts.push(
      chartFrom(
        "liquity-tcr",
        "System collateral ratio",
        "ratio",
        [lineFrom("tcr", "TCR", "#7c9eff", seriesOf(liquityBlocks, "tcr"))],
        { value: 1.5, label: "CCR — recovery mode" },
      ),
    );
    charts.push(
      chartFrom("liquity-fees", "Redemption / borrowing fee", "bps", [
        lineFrom(
          "redemption",
          "Redemption",
          "#f5a623",
          seriesOf(liquityBlocks, "redemptionRateBps"),
        ),
        lineFrom(
          "borrowing",
          "Borrowing",
          "#b18cf0",
          seriesOf(liquityBlocks, "borrowingRateBps"),
        ),
      ]),
    );

    const redemptions = blockSeriesOf(run, "liquity_redemption");
    tables.push({
      id: "liquity-redemptions",
      title: "Redemptions",
      columns: [
        { label: "Block" },
        { label: "eUSD redeemed", align: "right" },
        { label: "ETH out", align: "right" },
        { label: "ETH fee", align: "right" },
      ],
      rows: redemptions
        .slice(-24)
        .map((e) => [
          cell(Number(e.blockNumber).toLocaleString("en-US")),
          cell((fromWei(e.actualEusdWei) ?? 0).toFixed(2)),
          cell((fromWei(e.ethSentWei) ?? 0).toFixed(4)),
          cell((fromWei(e.ethFeeWei) ?? 0).toFixed(4), "down"),
        ]),
      empty:
        "nobody redeemed eUSD in this run — the discount never cleared the redemption fee, or nobody tried",
    });

    const troveLiquidations = blockSeriesOf(run, "liquity_liquidation");
    if (troveLiquidations.length > 0) {
      tables.push({
        id: "liquity-liquidations",
        title: "Trove liquidations",
        columns: [
          { label: "Block" },
          { label: "Borrower" },
          { label: "Debt", align: "right" },
          { label: "Collateral", align: "right" },
          { label: "Mode", align: "right" },
        ],
        rows: troveLiquidations
          .slice(-24)
          .map((e) => [
            cell(Number(e.blockNumber).toLocaleString("en-US")),
            cell(shortAddress(str(e.borrower)), "link"),
            cell(`${(fromWei(e.debtEusdWei) ?? 0).toFixed(0)} eUSD`),
            cell(`${(fromWei(e.collWei) ?? 0).toFixed(3)} ETH`),
            cell(num(e.operation) === 2 ? "recovery" : "normal"),
          ]),
        empty: "no trove was liquidated",
      });
    }
  }

  const priceChart = chartFrom(
    "stable-prices",
    "Stablecoin price against USDC",
    "ratio",
    priceLines,
    { value: 1, label: "par" },
  );
  if (priceChart) charts.unshift(priceChart);

  // --- depeg windows: what the environment did to the peg, and when ---
  const depegs = [
    ...blockSeriesOf(run, "stress_eusd_depeg"),
    ...blockSeriesOf(run, "stress_depeg"),
  ].sort((a, b) => Number(a.blockNumber) - Number(b.blockNumber));
  if (depegs.length > 0) {
    const peak = Math.max(...depegs.map((e) => num(e.targetFraction)));
    stats.push({
      label: "Depeg pressure",
      value: formatPercent(peak * 100),
      tone: "warn",
      sub: `${depegs.length} blocks of environment selling`,
    });
    tables.push({
      id: "depeg-windows",
      title: "Depeg windows (environment selling)",
      columns: [
        { label: "Block" },
        { label: "Stable" },
        { label: "Target share of depth", align: "right" },
        { label: "Sold", align: "right" },
      ],
      rows: depegs.slice(-24).map((e) => [
        cell(Number(e.blockNumber).toLocaleString("en-US")),
        cell(str(e.stable) || "EUSD", "link"),
        cell(formatPercent(num(e.targetFraction) * 100)),
        cell(
          (fromWei(e.soldStableWei) ?? 0).toLocaleString("en-US", {
            maximumFractionDigits: 0,
          }),
          "down",
        ),
      ]),
      empty: "the environment never leaned on a peg in this run",
    });
  }

  return {
    id: "stable",
    label: "Stablecoin",
    protocols,
    caption:
      "A stablecoin's price here is measured, not assumed: the mark is the geometric mean of both executable directions on its pool. eUSD adds a redemption floor — $1 of collateral from the riskiest trove — so its discount is a claim you can exercise, not a forecast.",
    stats,
    charts: charts.filter((c): c is VenueChart => c !== null),
    tables,
    ...(symbols.length === 0 && !lastLiquity
      ? {
          note: "no stablecoin market in this run (the price series arrives with market.json's stables field)",
        }
      : {}),
  };
}

function buildLstPanel(run: LoadedRun): VenuePanel {
  const stats: VenueStat[] = [];
  const charts: (VenueChart | null)[] = [];
  const tables: VenueTable[] = [];

  const setup = eventOfType(run.events, "lst_setup");
  const blocks = blockSeriesOf(run, "lst_block");
  const last = blocks[blocks.length - 1];

  if (last) {
    const rate = num(last.redemptionRateWeth);
    const marketPrice = num(last.marketPriceWeth);
    const discount = num(last.discountBps);
    stats.push({
      label: "Redemption rate",
      value: `${rate.toFixed(6)} WETH`,
      sub: "what the vault owes per LST — the par",
    });
    stats.push({
      label: "Market price",
      value: `${marketPrice.toFixed(6)} WETH`,
      // Below par is the normal state of a queued exit, not an alarm — only a material discount is.
      tone: discount > 20 ? "down" : "neutral",
      sub: "what the pool pays right now",
    });
    stats.push({
      label: "Discount",
      value: formatBps(discount),
      tone: discount > 20 ? "down" : "neutral",
      sub: "market below par; the exit queue is the reason it can persist",
    });
    stats.push({
      label: "Exit queue",
      value: String(num(last.queueLength)),
      sub: `withdrawal delay ${num(setup?.withdrawalDelayBlocks)} blocks`,
    });
    const reserve = fromWei(last.rewardReserveWei) ?? 0;
    stats.push({
      label: "Reward reserve",
      value: `${reserve.toFixed(3)} WETH`,
      tone: reserve <= 0 ? "down" : "neutral",
      sub:
        reserve <= 0
          ? "exhausted — yield has stopped"
          : `APY ${num(setup?.effectiveApyBps) / 100}%`,
    });

    charts.push(
      chartFrom("lst-rate", "Redemption rate vs market price", "eth", [
        lineFrom(
          "rate",
          "Redemption rate (par)",
          "#7c9eff",
          seriesOf(blocks, "redemptionRateWeth"),
          true,
        ),
        lineFrom(
          "market",
          "Market price",
          "#4fd1a5",
          seriesOf(blocks, "marketPriceWeth"),
        ),
      ]),
    );
    charts.push(
      chartFrom(
        "lst-discount",
        "Discount to par",
        "bps",
        [
          lineFrom(
            "discount",
            "Discount",
            "#f5a623",
            seriesOf(blocks, "discountBps"),
          ),
        ],
        { value: 0, label: "par" },
      ),
    );
    charts.push(
      chartFrom("lst-queue", "Exit queue length", "count", [
        lineFrom(
          "queue",
          "Queued exits",
          "#e879a6",
          seriesOf(blocks, "queueLength"),
        ),
      ]),
    );
  }

  const slashes = eventsOfType(run.events, "lst_slash");
  if (slashes.length > 0) {
    stats.push({
      label: "Slashes",
      value: String(slashes.length),
      tone: "down",
      sub: "permanent cuts to the redemption rate",
    });
  }
  tables.push({
    id: "lst-slashes",
    title: "Slash events",
    columns: [
      { label: "Rate before", align: "right" },
      { label: "Rate after", align: "right" },
      { label: "Cut", align: "right" },
      { label: "Discount after", align: "right" },
    ],
    rows: slashes.map((e) => [
      cell(num(e.redemptionRateBefore).toFixed(6)),
      cell(num(e.redemptionRateAfter).toFixed(6), "down"),
      cell(`${num(e.bps).toFixed(0)}bps`, "down"),
      cell(formatBps(num(e.discountBps))),
    ]),
    empty: "the vault was never slashed in this run",
  });

  const apyChanges = eventsOfType(run.events, "lst_apy_changed");
  if (apyChanges.length > 0) {
    tables.push({
      id: "lst-apy",
      title: "Yield changes",
      columns: [{ label: "Block" }, { label: "APY", align: "right" }],
      rows: apyChanges
        .slice(-24)
        .map((e) => [
          cell(Number(e.blockNumber).toLocaleString("en-US")),
          cell(`${num(e.apyBps) / 100}%`),
        ]),
      empty: "the yield was fixed for the whole run",
    });
  }

  return {
    id: "lst",
    label: "LST",
    protocols: ["lst"],
    caption:
      "A non-rebasing liquid staking token has two prices for one asset: the redemption rate the vault owes (behind a withdrawal queue) and what its secondary pool pays right now. The gap is only free money if you can afford to wait.",
    stats,
    charts: charts.filter((c): c is VenueChart => c !== null),
    tables,
    ...(last
      ? {}
      : { note: "no LST state was recorded in this run's event stream" }),
  };
}

/** The agents' decoded swaps in the base, newest first. */
function buildSwapTable(
  run: LoadedRun,
  infoByHash: Map<string, TxInfo>,
  base: string,
): VenueTable {
  const market = run.market;
  const rows: VenueTableCell[][] = [];
  for (const row of [...run.blockRows].reverse()) {
    if (row.role !== "agent") continue;
    const notional = market?.notionals[row.hash.toLowerCase()];
    if (
      !notional ||
      notional.base !== base ||
      !notional.side ||
      notional.priceUsd === undefined ||
      notional.baseUnits === undefined
    )
      continue;
    const venue = infoByHash.get(row.hash.toLowerCase())?.protocol;
    rows.push([
      cell(row.blockNumber.toLocaleString("en-US")),
      cell(row.ownerId, "link"),
      cell(venue ? (VENUE_LABELS[venue] ?? venue) : "—"),
      cell(
        notional.side === "buy" ? "BUY" : "SELL",
        notional.side === "buy" ? "up" : "down",
      ),
      cell(`${formatBaseUnits(notional.baseUnits)} ${base}`),
      cell(
        notional.priceUsd.toLocaleString("en-US", {
          maximumFractionDigits: 1,
        }),
      ),
    ]);
    if (rows.length >= 24) break;
  }
  return {
    id: "amm-swaps",
    title: `Agent swaps · ${base}`,
    columns: [
      { label: "Block" },
      { label: "Agent" },
      { label: "Venue" },
      { label: "Side" },
      { label: "Size", align: "right" },
      { label: "Price", align: "right" },
    ],
    rows,
    empty:
      "no agent swap in this base was decoded — either nobody traded it, or the run predates market.json",
  };
}

export function buildVenuePanels(
  run: LoadedRun,
  base: string,
  arbitrage: ArbitrageSnapshot,
  depths: VenueDepthView[],
  infoByHash: Map<string, TxInfo>,
  // The scenario panel is built from the unscoped run and the run's rounds: a schedule belongs to
  // the run, and reporting which rounds a window covers is what links the two.
  scenario?: VenuePanel,
): VenuePanel[] {
  const protocols = new Set(enabledProtocols(run));
  const panels: VenuePanel[] = [];
  if (scenario) panels.push(scenario);

  if (
    protocols.has("uniswap") ||
    protocols.has("balancer") ||
    protocols.has("curve") ||
    protocols.size === 0
  ) {
    panels.push(
      buildAmmPanel(
        run,
        base,
        arbitrage,
        depths,
        buildSwapTable(run, infoByHash, base),
      ),
    );
  }
  if (protocols.has("gmx")) panels.push(buildPerpPanel(run, base));
  if (protocols.has("aave")) panels.push(buildLendingPanel(run));
  // The stablecoin panel needs a stable with a market, not merely a venue: the AMM protocols are
  // enabled in every run, and an always-present empty tab teaches nothing.
  const hasStableMarket =
    protocols.has("liquity") ||
    (run.market ? stableSymbols(run.market).length > 0 : false);
  if (hasStableMarket) panels.push(buildStablePanel(run));
  if (protocols.has("lst")) panels.push(buildLstPanel(run));
  return panels;
}

// ---------------------------------------------------------------------------
// scenario history
//
// A run's market conditions are drawn from its SEED: the fair-price path, and the stress schedule
// laid over it (ADR 0009). The coordinator writes that schedule once, at run start, as blocks
// *relative* to the first block — so the plan exists, but nothing turned it into the one thing a
// reader wants: what was scheduled, when it actually fired, and whether it finished.
//
// This panel is always the whole run. A scenario is a property of the run, not of a round; what it
// reports instead is which rounds each window covers, so a round's result can be read against it.

type ScheduledEvent = {
  type?: string;
  base?: string;
  stable?: string;
  venue?: string;
  magnitude?: number;
  startBlock?: number;
  rampBlocks?: number;
  holdBlocks?: number;
  decayBlocks?: number;
  endBlock?: number;
};

// Only the event families the coordinator really emits per firing block. crash / spike / cexDrift /
// flowTrend are *not* here on purpose: they change the price walk itself and record nothing per
// block, so their row says so instead of reporting "never fired", which would be a different and
// false claim. The price series is where their effect is visible.
const SCENARIO_FIRING: Record<string, string[]> = {
  liquidityPull: ["stress_liquidity_pull"],
  eusdDepeg: ["stress_eusd_depeg"],
  depeg: ["stress_depeg"],
  lstSlash: ["lst_slash"],
  whale: ["stress_whale"],
};

/** How a schedule type shows up in the run, for the types that leave no per-block trace. */
const SCENARIO_UNRECORDED: Record<string, string> = {
  crash: "overlay on the fair price — see the price chart",
  spike: "overlay on the fair price — see the price chart",
  cexDrift: "changes the price walk — see the price chart",
  flowTrend: "tilts the order flow — see the swap volume",
};

/** The rounds a block window overlaps, as "3–5" / "4" / "—". */
function roundsSpanned(
  epochs: { index: number; fromBlock: number; toBlock: number }[],
  fromBlock: number,
  toBlock: number,
): string {
  const hit = epochs
    .filter((e) => e.fromBlock < toBlock && e.toBlock > fromBlock)
    .map((e) => e.index);
  if (hit.length === 0) return "—";
  return hit.length === 1
    ? String(hit[0])
    : `${hit[0]}–${hit[hit.length - 1]}`;
}

export function buildScenarioPanel(
  run: LoadedRun,
  epochs: { index: number; fromBlock: number; toBlock: number }[],
): VenuePanel {
  const started = eventOfType(run.events, "run_started_realtime");
  const schedule = eventOfType(run.events, "stress_schedule");
  const runStart = Number(schedule?.runStartBlock ?? started?.blockNumber ?? 0);
  const scheduled = (schedule?.events as ScheduledEvent[] | undefined) ?? [];

  const stats: VenueStat[] = [];
  const tables: VenueTable[] = [];

  // The seed is what makes a run reproducible, so it leads.
  if (started?.seed !== undefined) {
    stats.push({
      label: "Seed",
      value: String(num(started.seed)),
      sub: `flow seed ${num(started.flowSeed)} · the label for this run's market conditions`,
    });
  }
  stats.push({
    label: "Scheduled events",
    value: String(scheduled.length),
    tone: scheduled.length === 0 ? "neutral" : "warn",
    sub:
      scheduled.length === 0
        ? "none — the fair-price walk was the only thing moving"
        : scheduled.map((e) => str(e.type)).join(", "),
  });
  stats.push({
    label: "Run window",
    value: `${runStart.toLocaleString("en-US")} → ${(runStart + num(started?.runBlocks)).toLocaleString("en-US")}`,
    sub: `${num(started?.runBlocks)} blocks · ${epochs.length} rounds`,
  });

  // --- the plan, and what became of it ---
  const scheduleRows: VenueTableCell[][] = scheduled.map((event) => {
    const from = runStart + num(event.startBlock);
    const to = runStart + num(event.endBlock);
    const firingTypes = SCENARIO_FIRING[str(event.type)] ?? [];
    const unrecorded = SCENARIO_UNRECORDED[str(event.type)];
    const fired = firingTypes.flatMap((t) => blockSeriesOf(run, t));
    const firstFired = fired[0];
    const lastFired = fired[fired.length - 1];
    const failed = firingTypes.some(
      (t) => eventsOfType(run.events, `${t}_failed`).length > 0,
    );
    const restored = firingTypes.some(
      (t) => eventsOfType(run.events, `${t}_restored`).length > 0,
    );
    const ended = failed
      ? "failed"
      : restored
        ? "restored"
        : unrecorded || fired.length === 0
          ? ""
          : "left in place";
    const outcome = unrecorded
      ? unrecorded
      : fired.length === 0
        ? "never fired"
        : `${fired.length} blk ${Number(firstFired.blockNumber).toLocaleString("en-US")}–${Number(lastFired.blockNumber).toLocaleString("en-US")}${ended ? ` · ${ended}` : ""}`;
    return [
      cell(str(event.type), "link"),
      // The trapezoid's shape rides with its window: ramp/hold/decay is what the window is made of,
      // not a separate fact, and as its own column it did not fit beside the rest.
      cell(
        `${from.toLocaleString("en-US")}–${to.toLocaleString("en-US")} · r${num(event.rampBlocks)}/h${num(event.holdBlocks)}/d${num(event.decayBlocks)}`,
      ),
      cell(roundsSpanned(epochs, from, to)),
      cell(
        `${(num(event.magnitude) * 100).toFixed(1)}%`,
        num(event.magnitude) > 0 ? "warn" : "neutral",
      ),
      cell(
        outcome,
        failed
          ? "down"
          : restored
            ? "up"
            : !unrecorded && fired.length === 0
              ? "down"
              : "neutral",
      ),
    ];
  });

  tables.push({
    id: "scenario-schedule",
    title: "Stress schedule (drawn from the seed at run start)",
    columns: [
      { label: "Event", width: "110px" },
      { label: "Window · ramp/hold/decay", width: "205px" },
      { label: "Rounds", width: "60px" },
      { label: "Mag", align: "right", width: "60px" },
      { label: "Outcome", width: "minmax(0,1fr)" },
    ],
    rows: scheduleRows,
    empty:
      "no stress event was scheduled — this run is the fair-price walk and the order flow, nothing else",
  });

  // --- everything else the environment or the venues did, in block order ---
  const notable: { block: number; kind: string; text: string; tone?: "up" | "down" | "warn" }[] =
    [];
  for (const e of blockSeriesOf(run, "stress_liquidation"))
    notable.push({
      block: Number(e.blockNumber),
      kind: "liquidation",
      text: `victim ${str(e.victimId)} liquidated at HF ${(Number(e.healthFactor ?? 0) / 1e18).toFixed(3)}`,
      tone: "down",
    });
  for (const e of blockSeriesOf(run, "liquity_liquidation"))
    notable.push({
      block: Number(e.blockNumber),
      kind: "trove liquidated",
      text: `${shortAddress(str(e.borrower))} · ${(fromWei(e.debtEusdWei) ?? 0).toFixed(0)} eUSD`,
      tone: "down",
    });
  for (const e of blockSeriesOf(run, "liquity_redemption"))
    notable.push({
      block: Number(e.blockNumber),
      kind: "redemption",
      text: `${(fromWei(e.actualEusdWei) ?? 0).toFixed(0)} eUSD redeemed for ${(fromWei(e.ethSentWei) ?? 0).toFixed(4)} ETH`,
    });
  for (const e of eventsOfType(run.events, "lst_slash"))
    notable.push({
      block: Number(e.blockNumber ?? 0),
      kind: "lst slash",
      text: `redemption rate ${num(e.redemptionRateBefore).toFixed(6)} → ${num(e.redemptionRateAfter).toFixed(6)}`,
      tone: "down",
    });
  for (const e of blockSeriesOf(run, "no_arb_persistent_warning"))
    notable.push({
      block: Number(e.blockNumber),
      kind: "arb window",
      text: `${str(e.base)} ${str(e.buyVenue)}→${str(e.sellVenue)} open at ${num(e.profitBps).toFixed(0)}bps`,
      tone: "warn",
    });
  notable.sort((a, b) => a.block - b.block);

  if (notable.length > 0) {
    stats.push({
      label: "Venue events",
      value: String(notable.length),
      sub: "liquidations, redemptions, slashes and open arb windows",
    });
  }

  tables.push({
    id: "scenario-notable",
    title: "What the venues did, in block order",
    columns: [
      { label: "Block", width: "100px" },
      { label: "Round", width: "70px" },
      { label: "Event", width: "140px" },
      { label: "Detail", width: "minmax(0,2fr)" },
    ],
    rows: notable.slice(0, 40).map((n) => [
      cell(n.block.toLocaleString("en-US")),
      cell(roundsSpanned(epochs, n.block - 1, n.block)),
      cell(n.kind, n.tone ?? "neutral"),
      cell(n.text),
    ]),
    empty:
      "nothing was liquidated, redeemed or slashed, and no arb window stayed open long enough to be reported",
  });

  return {
    id: "scenario",
    label: "Scenario",
    runWide: true,
    protocols: [],
    caption:
      "What the environment did to this run. The stress schedule is drawn from the seed at run start as a trapezoid (ramp, hold, decay) over the fair-price walk, so it is randomised but reproducible — the same seed replays the same windows. Everything here is the whole run, whichever round is selected, because a scenario is a property of the run.",
    stats,
    charts: [],
    tables,
  };
}
