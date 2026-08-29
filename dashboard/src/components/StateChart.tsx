// A multi-line time series over block numbers — the shape every venue-state panel needs (pool
// depth, open interest, funding, utilization, a peg, a redemption rate). Deliberately generic: the
// provider decides what a venue's state is, this only draws it.
import { useEffect, useRef } from "react";
import {
  ColorType,
  createChart,
  CrosshairMode,
  LineSeries,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import { cssVar } from "@/lib/cssVar";
import type { ChartUnit, VenueChart } from "@/data/types";

function formatterFor(unit: ChartUnit): (value: number) => string {
  switch (unit) {
    case "usd":
      return (v) =>
        Math.abs(v) >= 1_000_000
          ? `$${(v / 1_000_000).toFixed(2)}M`
          : Math.abs(v) >= 1_000
            ? `$${(v / 1_000).toFixed(1)}k`
            : `$${v.toFixed(0)}`;
    case "bps":
      return (v) => `${v.toFixed(1)}bp`;
    case "percent":
      return (v) => `${v.toFixed(2)}%`;
    case "ratio":
      return (v) => v.toFixed(4);
    case "eth":
      return (v) => v.toFixed(6);
    case "count":
      return (v) => v.toFixed(0);
  }
}

export function StateChart({ chart }: { chart: VenueChart }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<Map<string, ISeriesApi<"Line">>>(new Map());
  const height = chart.height ?? 200;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const api = createChart(container, {
      width: container.clientWidth,
      height,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: cssVar("--text-tertiary"),
        fontFamily: "'JetBrains Mono', ui-monospace, monospace",
        fontSize: 11,
      },
      grid: {
        vertLines: { visible: false },
        horzLines: { color: cssVar("--border-subtle") },
      },
      rightPriceScale: { borderColor: cssVar("--border-subtle") },
      timeScale: {
        // The x values are block numbers, not timestamps. lightweight-charts would render them as
        // dates in 1970, so the axis is only shown where a formatter states what they really are.
        visible: chart.showBlockAxis === true,
        borderColor: cssVar("--border-subtle"),
        tickMarkFormatter: (time: number) => time.toLocaleString("en-US"),
      },
      localization: {
        timeFormatter: (time: number) => `block ${time.toLocaleString("en-US")}`,
      },
      crosshair: { mode: CrosshairMode.Normal },
      handleScroll: false,
      handleScale: false,
    });
    chartRef.current = api;

    const priceFormat = {
      type: "custom" as const,
      formatter: formatterFor(chart.unit),
      minMove: 0.000001,
    };

    const series = new Map<string, ISeriesApi<"Line">>();
    for (const line of chart.lines) {
      series.set(
        line.id,
        api.addSeries(LineSeries, {
          color: line.color,
          lineWidth: line.dashed ? 1 : 2,
          lineStyle: line.dashed ? LineStyle.Dashed : LineStyle.Solid,
          title: line.label,
          priceFormat,
        }),
      );
    }
    seriesRef.current = series;

    if (chart.reference) {
      series
        .values()
        .next()
        .value?.createPriceLine({
          price: chart.reference.value,
          color: cssVar("--text-tertiary"),
          lineWidth: 1,
          lineStyle: LineStyle.Dotted,
          axisLabelVisible: true,
          title: chart.reference.label,
        });
    }

    const resizeObserver = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width) api.applyOptions({ width });
    });
    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
      api.remove();
      chartRef.current = null;
      seriesRef.current = new Map();
    };
    // Series are rebuilt whenever the chart identity or its line set changes shape; per-point
    // updates below do not need a rebuild.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    chart.id,
    chart.unit,
    chart.showBlockAxis,
    chart.lines.map((l) => l.id).join("|"),
    chart.reference?.value,
    height,
  ]);

  useEffect(() => {
    for (const line of chart.lines) {
      seriesRef.current.get(line.id)?.setData(
        line.points.map((p) => ({
          time: p.time as UTCTimestamp,
          value: p.value,
        })),
      );
    }
    chartRef.current?.timeScale().fitContent();
  }, [chart]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: "14px",
          flexWrap: "wrap",
        }}
      >
        <span
          style={{
            font: "var(--weight-medium) 9px var(--font-mono)",
            letterSpacing: "var(--tracking-widest)",
            textTransform: "uppercase",
            color: "var(--text-tertiary)",
          }}
        >
          {chart.title}
        </span>
        {(chart.yLabel || chart.xLabel) && (
          <span
            style={{
              font: "10px var(--font-mono)",
              color: "var(--text-tertiary)",
            }}
          >
            {chart.yLabel ? `y: ${chart.yLabel}` : ""}
            {chart.yLabel && chart.xLabel ? "  ·  " : ""}
            {chart.xLabel ? `x: ${chart.xLabel}` : ""}
          </span>
        )}
        {chart.lines.map((line) => (
          <span
            key={line.id}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "5px",
              font: "10px var(--font-mono)",
              color: "var(--text-secondary)",
            }}
          >
            <span
              style={{
                width: "8px",
                height: line.dashed ? "0" : "8px",
                borderTop: line.dashed ? `2px dashed ${line.color}` : undefined,
                borderRadius: line.dashed ? 0 : "50%",
                background: line.dashed ? "transparent" : line.color,
                display: "inline-block",
              }}
            />
            {line.label}
          </span>
        ))}
      </div>
      <div ref={containerRef} style={{ width: "100%", height }} />
    </div>
  );
}
