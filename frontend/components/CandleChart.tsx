
"use client";

import { useEffect, useMemo, useRef } from "react";
import {
  createChart,
  CandlestickSeries,
  type BusinessDay,
  type UTCTimestamp,
  type Time,
  type CandlestickData,
  type IChartApi,
  type ISeriesApi,
  type LogicalRange,
} from "lightweight-charts";

type Candle = {
  time: string | number; // "YYYY-MM-DD" for daily, or ISO string / epoch for intraday
  open: number;
  high: number;
  low: number;
  close: number;
};

function isYYYYMMDD(s: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function toBusinessDay(s: string): BusinessDay {
  const [y, m, d] = s.split("-").map((v) => parseInt(v, 10));
  return { year: y, month: m, day: d };
}

function pad2(n: number) {
  return String(n).padStart(2, "0");
}

function formatBusinessDay(bd: BusinessDay) {
  return `${bd.year}-${pad2(bd.month)}-${pad2(bd.day)}`;
}

function toUtcTimestampSeconds(input: string | number): UTCTimestamp | null {
  if (typeof input === "number") {
    const sec = input > 1e12 ? Math.floor(input / 1000) : Math.floor(input);
    return sec > 0 ? (sec as UTCTimestamp) : null;
  }

  const s = input.trim();

  // Numeric string
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    const sec = n > 1e12 ? Math.floor(n / 1000) : Math.floor(n);
    return sec > 0 ? (sec as UTCTimestamp) : null;
  }

  const ms = Date.parse(s);
  if (!Number.isFinite(ms)) return null;

  const sec = Math.floor(ms / 1000);
  return sec > 0 ? (sec as UTCTimestamp) : null;
}

function normalizeCandles(candles: Candle[]): CandlestickData<Time>[] {
  const out: CandlestickData<Time>[] = [];

  for (const c of candles) {
    const t = c.time;

    // Daily candles: "YYYY-MM-DD" => BusinessDay
    if (typeof t === "string" && isYYYYMMDD(t)) {
      out.push({
        time: toBusinessDay(t),
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      });
      continue;
    }

    // Intraday candles: ISO string / epoch => UTCTimestamp (seconds)
    const ts = toUtcTimestampSeconds(t);
    if (!ts) continue;

    out.push({
      time: ts,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
    });
  }

  return out;
}

function fmtTime(t: Time): string {
  // BusinessDay
  if (typeof t === "object" && t && "year" in t && "month" in t && "day" in t) {
    return formatBusinessDay(t as BusinessDay);
  }
  // UTCTimestamp (seconds)
  if (typeof t === "number") {
    const d = new Date((t as number) * 1000);
    // Local time string is easiest for traders
    return d.toLocaleString();
  }
  return String(t);
}

export default function CandleChart({
  candles,
  timeframe,
}: {
  candles: Candle[];
  timeframe: string;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);

  // Tooltip overlay
  const tooltipRef = useRef<HTMLDivElement | null>(null);

  // Persist user zoom/scroll
  const savedRangeRef = useRef<LogicalRange | null>(null);
  const userInteractedRef = useRef(false);
  const initializingRef = useRef(true);

  const normalized = useMemo(() => normalizeCandles(candles), [candles]);

  // Create chart ONCE
  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      width: containerRef.current.clientWidth,
      height: 320,
      layout: { background: { color: "transparent" }, textColor: "#d4d4d8" },
      grid: { vertLines: { color: "#27272a" }, horzLines: { color: "#27272a" } },
      rightPriceScale: { borderColor: "#27272a" },
      timeScale: {
        borderColor: "#27272a",
        rightOffset: 5,
        // We do NOT auto-fit on every update. User zoom/scroll should remain stable.
      },
      crosshair: {
        vertLine: { color: "#3f3f46", width: 1 },
        horzLine: { color: "#3f3f46", width: 1 },
      },
    });

    const series = chart.addSeries(CandlestickSeries);

    chartRef.current = chart;
    seriesRef.current = series;

    // Save visible range whenever it changes (this is how we preserve zoom/scroll)
    const onRangeChange = (range: LogicalRange | null) => {
      if (!range) return;
      // The first few calls happen during init/data set — don't mark those as "user" interactions.
      if (!initializingRef.current) {
        userInteractedRef.current = true;
        savedRangeRef.current = range;
      }
    };

    chart.timeScale().subscribeVisibleLogicalRangeChange(onRangeChange);

    // Crosshair tooltip
    const onCrosshairMove = (param: any) => {
      const tip = tooltipRef.current;
      const s = seriesRef.current;
      if (!tip || !s) return;

      if (!param || !param.time || !param.seriesData) {
        tip.style.display = "none";
        return;
      }

      const sd = param.seriesData.get(s) as CandlestickData<Time> | undefined;
      if (!sd) {
        tip.style.display = "none";
        return;
      }

      // Position the tooltip near the cursor, but keep inside container
      const x = param.point?.x ?? 0;
      const y = param.point?.y ?? 0;

      // Build tooltip HTML
      const timeStr = fmtTime(param.time as Time);
      const o = Number(sd.open);
      const h = Number(sd.high);
      const l = Number(sd.low);
      const c = Number(sd.close);

      tip.innerHTML = `
        <div style="font-size:11px; color:#a1a1aa; margin-bottom:6px;">TF: <span style=\"color:#e4e4e7\">${timeframe}</span> • <span style=\"color:#e4e4e7\">${timeStr}</span></div>
        <div style="display:grid; grid-template-columns:auto auto; gap:4px 10px; font-size:12px;">
          <div style="color:#a1a1aa;">O</div><div style="color:#e4e4e7; text-align:right;">${o.toFixed(2)}</div>
          <div style="color:#a1a1aa;">H</div><div style="color:#e4e4e7; text-align:right;">${h.toFixed(2)}</div>
          <div style="color:#a1a1aa;">L</div><div style="color:#e4e4e7; text-align:right;">${l.toFixed(2)}</div>
          <div style="color:#a1a1aa;">C</div><div style="color:#e4e4e7; text-align:right;">${c.toFixed(2)}</div>
        </div>
      `;

      tip.style.display = "block";

      const container = containerRef.current;
      if (!container) return;

      const padding = 12;
      const tipW = tip.offsetWidth || 220;
      const tipH = tip.offsetHeight || 90;
      const cw = container.clientWidth;
      const ch = container.clientHeight;

      // Default: place to the right and slightly above cursor
      let left = x + padding;
      let top = y - tipH - padding;

      // Clamp within container
      if (left + tipW > cw) left = x - tipW - padding;
      if (left < padding) left = padding;
      if (top < padding) top = y + padding;
      if (top + tipH > ch - padding) top = ch - tipH - padding;

      tip.style.left = `${left}px`;
      tip.style.top = `${top}px`;
    };

    chart.subscribeCrosshairMove(onCrosshairMove);

    const onResize = () => {
      const c = containerRef.current;
      const chApi = chartRef.current;
      if (!c || !chApi) return;
      chApi.applyOptions({ width: c.clientWidth });
    };

    window.addEventListener("resize", onResize);

    return () => {
      window.removeEventListener("resize", onResize);
      try {
        chart.timeScale().unsubscribeVisibleLogicalRangeChange(onRangeChange);
      } catch {}
      try {
        chart.unsubscribeCrosshairMove(onCrosshairMove);
      } catch {}
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, [timeframe]);

  // Update data WITHOUT recreating chart. Preserve zoom/scroll.
  useEffect(() => {
    const chart = chartRef.current;
    const series = seriesRef.current;
    if (!chart || !series) return;

    // Update series data
    series.setData(normalized);

    // After first data set, stop treating range changes as init
    if (initializingRef.current) {
      initializingRef.current = false;
    }

    // Preserve user range if they've interacted (zoom/scroll)
    if (userInteractedRef.current && savedRangeRef.current) {
      try {
        chart.timeScale().setVisibleLogicalRange(savedRangeRef.current);
      } catch {
        // If it fails (e.g., not enough data), do nothing.
      }
    }

    // If the user has NOT interacted, do a gentle initial fit ONCE (first load only)
    if (!userInteractedRef.current && normalized.length > 0) {
      // We don't want this on every refresh; only when user hasn't touched the chart.
      // Using scrollToRealTime keeps newest candles visible without resetting zoom if untouched.
      try {
        chart.timeScale().scrollToRealTime();
      } catch {}
    }
  }, [normalized]);

  return (
    <div className="relative w-full min-w-0">
      <div ref={containerRef} className="w-full min-w-0" />
      <div
        ref={tooltipRef}
        style={{
          display: "none",
          position: "absolute",
          zIndex: 20,
          pointerEvents: "none",
          background: "rgba(9, 9, 11, 0.92)",
          border: "1px solid rgba(63, 63, 70, 0.8)",
          borderRadius: 10,
          padding: 10,
          boxShadow: "0 10px 30px rgba(0,0,0,0.35)",
          minWidth: 220,
          backdropFilter: "blur(8px)",
        }}
      />
    </div>
  );
}
