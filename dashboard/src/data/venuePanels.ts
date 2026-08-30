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

import { t } from "@/i18n/messages";
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
      label: t("vp.amm.widestGap"),
      value: formatBps(widest),
      tone: widest > arbitrage.thresholdBps ? "up" : "neutral",
      sub: t("vp.amm.threshold", { n: arbitrage.thresholdBps }),
    });
    stats.push({
      label: t("vp.amm.aboveThreshold"),
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
        label: t("vp.amm.poolDepth"),
        value: formatUsd(now),
        tone: now < start ? "down" : "neutral",
        sub: t("vp.amm.start", { v: formatUsd(start) }),
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
        label: t("vp.amm.swapVolume", { base }),
        value: formatUsd(volume),
        sub: t("vp.amm.swapsN", { n: swapCount.toLocaleString("en-US") }),
      });
    }

    charts.push(
      chartFrom(
        "amm-depth",
        t("vp.amm.depthChart", { base }),
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
        title: t("vp.amm.quotesTitle", { base }),
        columns: [
          { label: t("vp.col.venue") },
          { label: t("vp.col.mid"), align: "right" },
          { label: t("vp.col.sell"), align: "right" },
          { label: t("vp.col.buy"), align: "right" },
          { label: t("vp.col.depth"), align: "right" },
        ],
        rows,
        empty: t("vp.amm.quotesEmpty"),
      });
    }
  }

  tables.push(swaps);

  return {
    id: "amm",
    label: t("vp.amm.label"),
    protocols,
    caption: t("vp.amm.caption"),
    stats,
    charts: charts.filter((c): c is VenueChart => c !== null),
    tables,
    ...(depths.length === 0 && !market
      ? { note: t("vp.amm.note") }
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
      label: t("vp.perp.oi"),
      value: formatUsd(total),
      sub:
        total > 0
          ? t("vp.perp.oiSplit", {
              long: Math.round((lastGmx.longOiUsd / total) * 100),
              short: Math.round((lastGmx.shortOiUsd / total) * 100),
            })
          : t("vp.perp.noOi"),
    });
    stats.push({
      label: t("vp.perp.longOi"),
      value: formatUsd(lastGmx.longOiUsd),
      tone: "up",
    });
    stats.push({
      label: t("vp.perp.shortOi"),
      value: formatUsd(lastGmx.shortOiUsd),
      tone: "down",
    });
    stats.push({
      label: t("vp.perp.funding"),
      // absent = the funding read failed for that sample; "n/a" is honest, 0.00bps is not
      value:
        lastGmx.fundingPerHourBps !== undefined
          ? `${lastGmx.fundingPerHourBps.toFixed(3)}bps`
          : "n/a",
      sub: t("vp.perp.fundingSub"),
    });

    charts.push(
      chartFrom("gmx-oi", t("vp.perp.oiChart", { base }), "usd", [
        lineFrom(
          "long",
          t("vp.perp.long"),
          "#4fd1a5",
          rowsWithGmx.map((r) => ({
            time: r.block,
            value: r.gmx?.[base]?.longOiUsd ?? 0,
          })),
        ),
        lineFrom(
          "short",
          t("vp.perp.short"),
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
        t("vp.perp.fundingChart"),
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
        { value: 0, label: t("vp.perp.balanced") },
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
    title: t("vp.perp.positionsTitle"),
    columns: [
      { label: t("vp.col.agent") },
      { label: t("vp.col.side") },
      { label: t("vp.col.size"), align: "right" },
      { label: t("vp.col.collateral"), align: "right" },
      { label: t("vp.col.entry"), align: "right" },
      { label: t("vp.col.pnl"), align: "right" },
    ],
    rows: positions.map((p) => {
      const pnlPercent =
        p.entryPriceUsd && p.entryPriceUsd > 0 && lastFair > 0
          ? (lastFair / p.entryPriceUsd - 1) * 100 * (p.isLong ? 1 : -1)
          : 0;
      return [
        cell(p.agent, "link"),
        cell(p.isLong ? t("vp.side.long") : t("vp.side.short"), p.isLong ? "up" : "down"),
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
    empty: t("vp.perp.positionsEmpty"),
  });

  const keeperFailures = eventsOfType(run.events, "keeper_failed").length;
  if (keeperFailures > 0) {
    stats.push({
      label: t("vp.perp.keeperFailures"),
      value: String(keeperFailures),
      tone: "warn",
      sub: t("vp.perp.keeperSub"),
    });
  }

  return {
    id: "perp",
    label: t("vp.perp.label"),
    protocols: ["gmx"],
    caption: t("vp.perp.caption"),
    stats,
    charts: charts.filter((c): c is VenueChart => c !== null),
    tables,
    ...(lastGmx
      ? {}
      : {
          note: market
            ? t("vp.perp.noState", { base })
            : t("vp.perp.note"),
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
    stats.push({ label: t("vp.lending.supplied"), value: formatUsd(supplied) });
    stats.push({
      label: t("vp.lending.borrowed"),
      value: formatUsd(borrowed),
      sub:
        supplied > 0
          ? t("vp.lending.utilization", {
              v: formatPercent((borrowed / supplied) * 100, 2),
            })
          : undefined,
    });

    charts.push(
      chartFrom(
        "aave-borrowed",
        t("vp.lending.borrowedChart"),
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
        t("vp.lending.utilizationChart"),
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
      title: t("vp.lending.reservesTitle"),
      columns: [
        { label: t("vp.col.asset") },
        { label: t("vp.col.suppliedCol"), align: "right" },
        { label: t("vp.col.borrowedCol"), align: "right" },
        { label: t("vp.col.utilizationCol"), align: "right" },
      ],
      rows: assets.map((asset) => [
        cell(asset, "link"),
        cell(formatUsd(lastAave[asset].suppliedUsd)),
        cell(formatUsd(lastAave[asset].borrowedUsd)),
        cell(formatPercent(lastAave[asset].utilization * 100, 2)),
      ]),
      empty: t("vp.lending.reservesEmpty"),
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
      label: t("vp.lending.worstHf"),
      value: worst.toFixed(3),
      tone: worst < 1 ? "down" : "neutral",
      sub: worst < 1 ? t("vp.lending.liquidatable") : t("vp.lending.aboveLine"),
    });
    charts.push(
      chartFrom(
        "aave-victim-hf",
        t("vp.lending.victimChart"),
        "ratio",
        [lineFrom("hf", t("vp.lending.minHf"), "#e879a6", victimHf)],
        { value: 1, label: t("vp.lending.liquidationLine") },
      ),
    );
  }

  const liquidations = blockSeriesOf(run, "stress_liquidation");
  if (liquidations.length > 0) {
    stats.push({
      label: t("vp.lending.liquidations"),
      value: String(liquidations.length),
      tone: "down",
    });
  }
  tables.push({
    id: "aave-liquidations",
    title: t("vp.lending.liquidations"),
    columns: [
      { label: t("vp.col.block") },
      { label: t("vp.col.victim") },
      { label: t("vp.col.healthFactor"), align: "right" },
      { label: t("vp.col.remainingDebt"), align: "right" },
    ],
    rows: liquidations.slice(-24).map((e) => [
      cell(Number(e.blockNumber).toLocaleString("en-US")),
      cell(str(e.victimId), "link"),
      cell((Number(e.healthFactor ?? 0) / 1e18).toFixed(3), "down"),
      // Aave base units are 8-decimal USD.
      cell(formatUsd((fromWei(e.remainingDebtBase, 8) ?? 0) as number)),
    ]),
    empty: t("vp.lending.liquidationsEmpty"),
  });

  const accounts = market?.aaveAccountsAtEnd ?? [];
  tables.push({
    id: "aave-accounts",
    title: t("vp.lending.accountsTitle"),
    columns: [
      { label: t("vp.col.agent") },
      { label: t("vp.col.collateral"), align: "right" },
      { label: t("vp.col.debt"), align: "right" },
      { label: t("vp.col.healthFactor"), align: "right" },
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
    empty: t("vp.lending.accountsEmpty"),
  });

  return {
    id: "lending",
    label: t("vp.lending.label"),
    protocols: ["aave"],
    caption: t("vp.lending.caption"),
    stats,
    charts: charts.filter((c): c is VenueChart => c !== null),
    tables,
    ...(lastAave
      ? {}
      : {
          note: market ? t("vp.lending.noState") : t("vp.lending.note"),
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
      label: t("vp.stable.price", { symbol }),
      value: last.priceUsdc.toFixed(4),
      tone: last.priceUsdc < 0.999 ? "down" : "neutral",
      sub: last.quoted
        ? t("vp.stable.deepest", {
            v: Number.isFinite(lowest) ? lowest.toFixed(4) : "—",
            bps: formatBps((last.priceUsdc - 1) * 10_000),
          })
        : t("vp.stable.noQuote"),
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
      label: t("vp.stable.tcr"),
      value: tcr.toFixed(3),
      tone: tcr < 1.5 ? "down" : "neutral",
      sub: lastLiquity.recoveryMode
        ? t("vp.stable.recovery")
        : t("vp.stable.aboveCcr"),
    });
    stats.push({
      label: t("vp.stable.troves"),
      value: String(num(lastLiquity.troveCount)),
      sub: t("vp.stable.riskiest", {
        v: Number(lastLiquity.riskiestIcr ?? 0).toFixed(3),
      }),
    });
    stats.push({
      label: t("vp.stable.debt"),
      value: `${debt.toLocaleString("en-US", { maximumFractionDigits: 0 })}`,
      sub: t("vp.stable.spSub", {
        v: sp.toLocaleString("en-US", { maximumFractionDigits: 0 }),
      }),
    });
    stats.push({
      label: t("vp.stable.redemptionFee"),
      value: `${num(lastLiquity.redemptionRateBps).toFixed(1)}bps`,
      sub: t("vp.stable.borrowingSub", {
        v: num(lastLiquity.borrowingRateBps).toFixed(1),
      }),
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
        label: t("vp.stable.eusdPrice"),
        value: price.toFixed(4),
        tone: price < 0.999 ? "down" : "neutral",
        sub: t("vp.stable.deepest", {
          v: Number.isFinite(deepest) ? deepest.toFixed(4) : "—",
          bps: formatBps(num(lastLiquity.discountBps) * -1),
        }),
      });
    }

    // The eUSD peg from the venue's own per-block read. It is the same pool the market-priced
    // stable probe uses, but recorded live rather than reconstructed — so it exists for runs that
    // predate the stables field in market.json.
    if (priceLines.every((l) => l === null || l.id !== "EUSD")) {
      priceLines.push(
        lineFrom(
          "EUSD",
          t("vp.stable.eusdVenueRead"),
          seriesColor(symbols.length),
          seriesOf(liquityBlocks, "marketPriceUsdc"),
        ),
      );
    }

    charts.push(
      chartFrom(
        "liquity-tcr",
        t("vp.stable.tcrChart"),
        "ratio",
        [lineFrom("tcr", "TCR", "#7c9eff", seriesOf(liquityBlocks, "tcr"))],
        { value: 1.5, label: t("vp.stable.ccrLine") },
      ),
    );
    charts.push(
      chartFrom("liquity-fees", t("vp.stable.feesChart"), "bps", [
        lineFrom(
          "redemption",
          t("vp.stable.redemptionLine"),
          "#f5a623",
          seriesOf(liquityBlocks, "redemptionRateBps"),
        ),
        lineFrom(
          "borrowing",
          t("vp.stable.borrowingLine"),
          "#b18cf0",
          seriesOf(liquityBlocks, "borrowingRateBps"),
        ),
      ]),
    );

    const redemptions = blockSeriesOf(run, "liquity_redemption");
    tables.push({
      id: "liquity-redemptions",
      title: t("vp.stable.redemptionsTitle"),
      columns: [
        { label: t("vp.col.block") },
        { label: t("vp.col.eusdRedeemed"), align: "right" },
        { label: t("vp.col.ethOut"), align: "right" },
        { label: t("vp.col.ethFee"), align: "right" },
      ],
      rows: redemptions
        .slice(-24)
        .map((e) => [
          cell(Number(e.blockNumber).toLocaleString("en-US")),
          cell((fromWei(e.actualEusdWei) ?? 0).toFixed(2)),
          cell((fromWei(e.ethSentWei) ?? 0).toFixed(4)),
          cell((fromWei(e.ethFeeWei) ?? 0).toFixed(4), "down"),
        ]),
      empty: t("vp.stable.redemptionsEmpty"),
    });

    const troveLiquidations = blockSeriesOf(run, "liquity_liquidation");
    if (troveLiquidations.length > 0) {
      tables.push({
        id: "liquity-liquidations",
        title: t("vp.stable.troveLiqTitle"),
        columns: [
          { label: t("vp.col.block") },
          { label: t("vp.col.borrower") },
          { label: t("vp.col.debt"), align: "right" },
          { label: t("vp.col.collateral"), align: "right" },
          { label: t("vp.col.mode"), align: "right" },
        ],
        rows: troveLiquidations
          .slice(-24)
          .map((e) => [
            cell(Number(e.blockNumber).toLocaleString("en-US")),
            cell(shortAddress(str(e.borrower)), "link"),
            cell(`${(fromWei(e.debtEusdWei) ?? 0).toFixed(0)} eUSD`),
            cell(`${(fromWei(e.collWei) ?? 0).toFixed(3)} ETH`),
            cell(
              num(e.operation) === 2
                ? t("vp.stable.modeRecovery")
                : t("vp.stable.modeNormal"),
            ),
          ]),
        empty: t("vp.stable.troveLiqEmpty"),
      });
    }
  }

  const priceChart = chartFrom(
    "stable-prices",
    t("vp.stable.priceChart"),
    "ratio",
    priceLines,
    { value: 1, label: t("vp.stable.parLine") },
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
      label: t("vp.stable.depegPressure"),
      value: formatPercent(peak * 100),
      tone: "warn",
      sub: t("vp.stable.depegSub", { n: depegs.length }),
    });
    tables.push({
      id: "depeg-windows",
      title: t("vp.stable.depegTitle"),
      columns: [
        { label: t("vp.col.block") },
        { label: t("vp.col.stable") },
        { label: t("vp.col.targetShare"), align: "right" },
        { label: t("vp.col.sold"), align: "right" },
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
      empty: t("vp.stable.depegEmpty"),
    });
  }

  return {
    id: "stable",
    label: t("vp.stable.label"),
    protocols,
    caption: t("vp.stable.caption"),
    stats,
    charts: charts.filter((c): c is VenueChart => c !== null),
    tables,
    ...(symbols.length === 0 && !lastLiquity
      ? { note: t("vp.stable.note") }
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
      label: t("vp.lst.rate"),
      value: `${rate.toFixed(6)} WETH`,
      sub: t("vp.lst.rateSub"),
    });
    stats.push({
      label: t("vp.lst.market"),
      value: `${marketPrice.toFixed(6)} WETH`,
      // Below par is the normal state of a queued exit, not an alarm — only a material discount is.
      tone: discount > 20 ? "down" : "neutral",
      sub: t("vp.lst.marketSub"),
    });
    stats.push({
      label: t("vp.lst.discount"),
      value: formatBps(discount),
      tone: discount > 20 ? "down" : "neutral",
      sub: t("vp.lst.discountSub"),
    });
    stats.push({
      label: t("vp.lst.queue"),
      value: String(num(last.queueLength)),
      sub: t("vp.lst.queueSub", { n: num(setup?.withdrawalDelayBlocks) }),
    });
    const reserve = fromWei(last.rewardReserveWei) ?? 0;
    stats.push({
      label: t("vp.lst.reserve"),
      value: `${reserve.toFixed(3)} WETH`,
      tone: reserve <= 0 ? "down" : "neutral",
      sub:
        reserve <= 0
          ? t("vp.lst.reserveEmpty")
          : t("vp.lst.apy", { v: num(setup?.effectiveApyBps) / 100 }),
    });

    charts.push(
      chartFrom("lst-rate", t("vp.lst.rateChart"), "eth", [
        lineFrom(
          "rate",
          t("vp.lst.rateLine"),
          "#7c9eff",
          seriesOf(blocks, "redemptionRateWeth"),
          true,
        ),
        lineFrom(
          "market",
          t("vp.lst.marketLine"),
          "#4fd1a5",
          seriesOf(blocks, "marketPriceWeth"),
        ),
      ]),
    );
    charts.push(
      chartFrom(
        "lst-discount",
        t("vp.lst.discountChart"),
        "bps",
        [
          lineFrom(
            "discount",
            t("vp.lst.discountLine"),
            "#f5a623",
            seriesOf(blocks, "discountBps"),
          ),
        ],
        { value: 0, label: t("vp.stable.parLine") },
      ),
    );
    charts.push(
      chartFrom("lst-queue", t("vp.lst.queueChart"), "count", [
        lineFrom(
          "queue",
          t("vp.lst.queueLine"),
          "#e879a6",
          seriesOf(blocks, "queueLength"),
        ),
      ]),
    );
  }

  const slashes = eventsOfType(run.events, "lst_slash");
  if (slashes.length > 0) {
    stats.push({
      label: t("vp.lst.slashes"),
      value: String(slashes.length),
      tone: "down",
      sub: t("vp.lst.slashesSub"),
    });
  }
  tables.push({
    id: "lst-slashes",
    title: t("vp.lst.slashTitle"),
    columns: [
      { label: t("vp.col.rateBefore"), align: "right" },
      { label: t("vp.col.rateAfter"), align: "right" },
      { label: t("vp.col.cut"), align: "right" },
      { label: t("vp.col.discountAfter"), align: "right" },
    ],
    rows: slashes.map((e) => [
      cell(num(e.redemptionRateBefore).toFixed(6)),
      cell(num(e.redemptionRateAfter).toFixed(6), "down"),
      cell(`${num(e.bps).toFixed(0)}bps`, "down"),
      cell(formatBps(num(e.discountBps))),
    ]),
    empty: t("vp.lst.slashEmpty"),
  });

  const apyChanges = eventsOfType(run.events, "lst_apy_changed");
  if (apyChanges.length > 0) {
    tables.push({
      id: "lst-apy",
      title: t("vp.lst.apyTitle"),
      columns: [
        { label: t("vp.col.block") },
        { label: t("vp.col.apy"), align: "right" },
      ],
      rows: apyChanges
        .slice(-24)
        .map((e) => [
          cell(Number(e.blockNumber).toLocaleString("en-US")),
          cell(`${num(e.apyBps) / 100}%`),
        ]),
      empty: t("vp.lst.apyEmpty"),
    });
  }

  return {
    id: "lst",
    label: t("vp.lst.label"),
    protocols: ["lst"],
    caption: t("vp.lst.caption"),
    stats,
    charts: charts.filter((c): c is VenueChart => c !== null),
    tables,
    ...(last
      ? {}
      : { note: t("vp.lst.note") }),
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
        notional.side === "buy" ? t("vp.side.buy") : t("vp.side.sell"),
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
    title: t("vp.amm.swapsTitle", { base }),
    columns: [
      { label: t("vp.col.block") },
      { label: t("vp.col.agent") },
      { label: t("vp.col.venue") },
      { label: t("vp.col.side") },
      { label: t("vp.col.size"), align: "right" },
      { label: t("vp.col.price"), align: "right" },
    ],
    rows,
    empty: t("vp.amm.swapsEmpty"),
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
const scenarioUnrecorded = (type: string): string | undefined => {
  switch (type) {
    case "crash":
    case "spike":
      return t("vp.scenario.crash");
    case "cexDrift":
      return t("vp.scenario.cexDrift");
    case "flowTrend":
      return t("vp.scenario.flowTrend");
    default:
      return undefined;
  }
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
      label: t("vp.scenario.seed"),
      value: String(num(started.seed)),
      sub: t("vp.scenario.seedSub", { flow: num(started.flowSeed) }),
    });
  }
  stats.push({
    label: t("vp.scenario.scheduled"),
    value: String(scheduled.length),
    tone: scheduled.length === 0 ? "neutral" : "warn",
    sub:
      scheduled.length === 0
        ? t("vp.scenario.scheduledNone")
        : scheduled.map((e) => str(e.type)).join(", "),
  });
  stats.push({
    label: t("vp.scenario.window"),
    value: `${runStart.toLocaleString("en-US")} → ${(runStart + num(started?.runBlocks)).toLocaleString("en-US")}`,
    sub: t("vp.scenario.windowSub", {
      blocks: num(started?.runBlocks),
      rounds: epochs.length,
    }),
  });

  // --- the plan, and what became of it ---
  const scheduleRows: VenueTableCell[][] = scheduled.map((event) => {
    const from = runStart + num(event.startBlock);
    const to = runStart + num(event.endBlock);
    const firingTypes = SCENARIO_FIRING[str(event.type)] ?? [];
    const unrecorded = scenarioUnrecorded(str(event.type));
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
      ? t("vp.scenario.failed")
      : restored
        ? t("vp.scenario.restored")
        : unrecorded || fired.length === 0
          ? ""
          : t("vp.scenario.leftInPlace");
    const outcome = unrecorded
      ? unrecorded
      : fired.length === 0
        ? t("vp.scenario.neverFired")
        : `${t("vp.scenario.firedBlocks", {
            n: fired.length,
            from: Number(firstFired.blockNumber).toLocaleString("en-US"),
            to: Number(lastFired.blockNumber).toLocaleString("en-US"),
          })}${ended ? ` · ${ended}` : ""}`;
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
    title: t("vp.scenario.scheduleTitle"),
    columns: [
      { label: t("vp.col.event"), width: "110px" },
      { label: t("vp.col.windowShape"), width: "205px" },
      { label: t("vp.col.rounds"), width: "60px" },
      { label: t("vp.col.mag"), align: "right", width: "60px" },
      { label: t("vp.col.outcome"), width: "minmax(0,1fr)" },
    ],
    rows: scheduleRows,
    empty: t("vp.scenario.scheduleEmpty"),
  });

  // --- everything else the environment or the venues did, in block order ---
  const notable: { block: number; kind: string; text: string; tone?: "up" | "down" | "warn" }[] =
    [];
  for (const e of blockSeriesOf(run, "stress_liquidation"))
    notable.push({
      block: Number(e.blockNumber),
      kind: t("vp.scenario.liquidation"),
      text: t("vp.scenario.liquidationText", {
        victim: str(e.victimId),
        hf: (Number(e.healthFactor ?? 0) / 1e18).toFixed(3),
      }),
      tone: "down",
    });
  for (const e of blockSeriesOf(run, "liquity_liquidation"))
    notable.push({
      block: Number(e.blockNumber),
      kind: t("vp.scenario.troveLiquidated"),
      text: t("vp.scenario.troveText", {
        borrower: shortAddress(str(e.borrower)),
        debt: (fromWei(e.debtEusdWei) ?? 0).toFixed(0),
      }),
      tone: "down",
    });
  for (const e of blockSeriesOf(run, "liquity_redemption"))
    notable.push({
      block: Number(e.blockNumber),
      kind: t("vp.scenario.redemption"),
      text: t("vp.scenario.redemptionText", {
        eusd: (fromWei(e.actualEusdWei) ?? 0).toFixed(0),
        eth: (fromWei(e.ethSentWei) ?? 0).toFixed(4),
      }),
    });
  for (const e of eventsOfType(run.events, "lst_slash"))
    notable.push({
      block: Number(e.blockNumber ?? 0),
      kind: t("vp.scenario.lstSlash"),
      text: t("vp.scenario.lstSlashText", {
        before: num(e.redemptionRateBefore).toFixed(6),
        after: num(e.redemptionRateAfter).toFixed(6),
      }),
      tone: "down",
    });
  for (const e of blockSeriesOf(run, "no_arb_persistent_warning"))
    notable.push({
      block: Number(e.blockNumber),
      kind: t("vp.scenario.arbWindow"),
      text: t("vp.scenario.arbWindowText", {
        base: str(e.base),
        buy: str(e.buyVenue),
        sell: str(e.sellVenue),
        bps: num(e.profitBps).toFixed(0),
      }),
      tone: "warn",
    });
  notable.sort((a, b) => a.block - b.block);

  if (notable.length > 0) {
    stats.push({
      label: t("vp.scenario.venueEvents"),
      value: String(notable.length),
      sub: t("vp.scenario.venueEventsSub"),
    });
  }

  tables.push({
    id: "scenario-notable",
    title: t("vp.scenario.notableTitle"),
    columns: [
      { label: t("vp.col.block"), width: "100px" },
      { label: t("vp.col.round"), width: "70px" },
      { label: t("vp.col.event"), width: "140px" },
      { label: t("vp.col.detail"), width: "minmax(0,2fr)" },
    ],
    rows: notable.slice(0, 40).map((n) => [
      cell(n.block.toLocaleString("en-US")),
      cell(roundsSpanned(epochs, n.block - 1, n.block)),
      cell(n.kind, n.tone ?? "neutral"),
      cell(n.text),
    ]),
    empty: t("vp.scenario.notableEmpty"),
  });

  return {
    id: "scenario",
    label: t("vp.scenario.label"),
    runWide: true,
    protocols: [],
    caption: t("vp.scenario.caption"),
    stats,
    charts: [],
    tables,
  };
}
