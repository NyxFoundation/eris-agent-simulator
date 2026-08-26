import { useEffect, useRef } from "react";
import {
  ColorType,
  createChart,
  createSeriesMarkers,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import { cssVar } from "@/lib/cssVar";
import type { ArbitrageSnapshot } from "@/data/types";

export function ArbitrageChart({ data, height = 320 }: { data: ArbitrageSnapshot; height?: number }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const fairSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const spreadSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const venueSeriesRef = useRef<Map<string, ISeriesApi<"Line">>>(new Map());

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const chart = createChart(container, {
      width: container.clientWidth,
      height,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: cssVar("--text-tertiary"),
        fontFamily: "'JetBrains Mono', ui-monospace, monospace",
        fontSize: 11,
        panes: { separatorColor: cssVar("--border-subtle") },
      },
      grid: {
        vertLines: { visible: false },
        horzLines: { color: cssVar("--border-subtle") },
      },
      rightPriceScale: { borderColor: cssVar("--border-subtle") },
      timeScale: { visible: false, borderColor: cssVar("--border-subtle") },
      crosshair: { mode: CrosshairMode.Normal },
      handleScroll: false,
      handleScale: false,
    });
    chartRef.current = chart;

    fairSeriesRef.current = chart.addSeries(
      LineSeries,
      {
        color: cssVar("--text-tertiary"),
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        title: "fair",
      },
      0,
    );

    const venueSeries = new Map<string, ISeriesApi<"Line">>();
    for (const venue of data.venues) {
      venueSeries.set(
        venue.id,
        chart.addSeries(LineSeries, { color: venue.color, lineWidth: 2, title: venue.label }, 0),
      );
    }
    venueSeriesRef.current = venueSeries;

    const spreadSeries = chart.addSeries(
      HistogramSeries,
      { color: cssVar("--text-tertiary"), priceFormat: { type: "custom", formatter: (v: number) => `${v.toFixed(0)}bps` } },
      1,
    );
    spreadSeriesRef.current = spreadSeries;
    spreadSeries.createPriceLine({
      price: data.thresholdBps,
      color: cssVar("--danger"),
      lineWidth: 1,
      lineStyle: LineStyle.Dotted,
      axisLabelVisible: true,
      title: `${data.thresholdBps}bps round-trip cost`,
    });

    markersRef.current = createSeriesMarkers(spreadSeries, []);

    const panes = chart.panes();
    panes[0]?.setStretchFactor(3);
    panes[1]?.setStretchFactor(1);

    const resizeObserver = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width) chart.applyOptions({ width });
    });
    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
      chart.remove();
      chartRef.current = null;
      fairSeriesRef.current = null;
      spreadSeriesRef.current = null;
      markersRef.current = null;
      venueSeriesRef.current = new Map();
    };
    // Series/panes are rebuilt from scratch on mount and whenever the venue set changes shape;
    // per-point updates below don't need this effect to rerun.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [height, data.venues.length, data.thresholdBps]);

  useEffect(() => {
    fairSeriesRef.current?.setData(data.fair.map((p) => ({ time: p.time as UTCTimestamp, value: p.price })));

    for (const venue of data.venues) {
      venueSeriesRef.current
        .get(venue.id)
        ?.setData(venue.points.map((p) => ({ time: p.time as UTCTimestamp, value: p.price })));
    }

    const dangerColor = cssVar("--danger");
    const tertiaryColor = cssVar("--text-tertiary");
    spreadSeriesRef.current?.setData(
      data.spread.map((s) => ({
        time: s.time as UTCTimestamp,
        value: s.spreadBps,
        color: s.spreadBps > data.thresholdBps ? dangerColor : tertiaryColor,
      })),
    );

    const venueColor = new Map(data.venues.map((v) => [v.id, v.color]));
    const markers: SeriesMarker<Time>[] = data.trades.map((t) => ({
      time: t.time as UTCTimestamp,
      position: t.side === "buy" ? "belowBar" : "aboveBar",
      color: venueColor.get(t.venue) ?? tertiaryColor,
      shape: t.side === "buy" ? "arrowUp" : "arrowDown",
      text: `${t.side} ${t.venue}`,
    }));
    markersRef.current?.setMarkers(markers);

    chartRef.current?.timeScale().fitContent();
  }, [data]);

  return <div ref={containerRef} style={{ width: "100%", height }} />;
}
