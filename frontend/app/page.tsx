"use client";

import { useMemo, useState } from "react";
import CandleChart from "../components/CandleChart";

/**
 * testing the save
 * Deployment-ready API base:
 * - Local dev fallback: http://localhost:8000
 * - Vercel prod: set NEXT_PUBLIC_API_BASE_URL to your Render backend URL
 */
const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:8000";

type PredictResponse = {
  symbol: string;
  timeframe: "daily" | "weekly";
  last_close: number;
  prediction: number;
  range_low: number;
  range_high: number;
  confidence: number;
  data_points: number;
  source: string;
  market: {
    SPY_last_close: number;
    QQQ_last_close: number;
    SPY_ret_1: number; // percent
    QQQ_ret_1: number; // percent
  };
  cache?: { hit: boolean; ttl_sec: number };
};

type HistoryResponse = {
  symbol: string;
  timeframe: "daily" | "weekly";
  candles: {
    time: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  }[];
};

export default function Home() {
  const [symbol, setSymbol] = useState("AAPL");
  const [timeframe, setTimeframe] = useState<"daily" | "weekly">("daily");
  const [loading, setLoading] = useState(false);
  const [pred, setPred] = useState<PredictResponse | null>(null);
  const [hist, setHist] = useState<HistoryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const candles = useMemo(() => hist?.candles ?? [], [hist]);

  async function run() {
    const s = symbol.trim().toUpperCase();
    if (!s) return;

    setLoading(true);
    setError(null);

    try {
      const [predRes, histRes] = await Promise.all([
        fetch(`${API_BASE}/predict`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ symbol: s, timeframe }),
        }),
        fetch(
          `${API_BASE}/history/${encodeURIComponent(
            s
          )}?timeframe=${timeframe}&points=200`
        ),
      ]);

      if (!predRes.ok) throw new Error(`Predict API error: ${predRes.status}`);
      if (!histRes.ok) throw new Error(`History API error: ${histRes.status}`);

      const predJson = (await predRes.json()) as PredictResponse;
      const histJson = (await histRes.json()) as HistoryResponse;

      setPred(predJson);
      setHist(histJson);
    } catch (e: any) {
      setError(
        e?.message ??
          `Network error (is backend running on ${API_BASE}/health ?)`
      );
      setPred(null);
      setHist(null);
    } finally {
      setLoading(false);
    }
  }

  const changePct =
    pred ? ((pred.prediction - pred.last_close) / pred.last_close) * 100 : null;

  function badgeForPct(p: number) {
    const up = p >= 0;
    return (
      <span
        className={`px-2 py-1 rounded-lg text-xs border ${
          up
            ? "border-emerald-700 bg-emerald-950/40 text-emerald-200"
            : "border-red-700 bg-red-950/40 text-red-200"
        }`}
      >
        {up ? "+" : ""}
        {p.toFixed(2)}%
      </span>
    );
  }

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100">
      <div className="max-w-5xl mx-auto p-6">
        <header className="flex flex-col gap-2">
          <h1 className="text-3xl font-semibold tracking-tight">
            Stock Price Predictor
          </h1>
          <p className="text-sm text-zinc-400 max-w-2xl">
            Forecasting demo using free market data + baseline ML with market
            context (SPY/QQQ). Not financial advice.
          </p>
        </header>

        <section className="mt-6 grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="md:col-span-2 rounded-2xl border border-zinc-800 bg-zinc-900/40 p-5">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex gap-3 w-full">
                <input
                  className="flex-1 rounded-xl bg-zinc-950 border border-zinc-800 px-4 py-3 outline-none focus:ring-2 focus:ring-zinc-600"
                  value={symbol}
                  onChange={(e) => setSymbol(e.target.value)}
                  placeholder="Ticker (e.g., AAPL)"
                />

                <select
                  className="rounded-xl bg-zinc-950 border border-zinc-800 px-3 py-3 outline-none focus:ring-2 focus:ring-zinc-600"
                  value={timeframe}
                  onChange={(e) => setTimeframe(e.target.value as any)}
                >
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                </select>

                <button
                  onClick={run}
                  disabled={loading}
                  className="rounded-xl px-5 py-3 bg-zinc-100 text-zinc-900 font-medium hover:bg-white disabled:opacity-60"
                >
                  {loading ? "Running..." : "Predict"}
                </button>
              </div>
            </div>

            {error && (
              <div className="mt-4 rounded-xl border border-red-800 bg-red-950/40 p-4 text-sm text-red-200">
                {error}
              </div>
            )}

            {/* Market context row */}
            <div className="mt-4 flex flex-wrap gap-2 text-xs text-zinc-300">
              <span className="px-2 py-1 rounded-lg border border-zinc-800 bg-zinc-950">
                Market context:
              </span>
              {pred ? (
                <>
                  <span className="px-2 py-1 rounded-lg border border-zinc-800 bg-zinc-950">
                    SPY {badgeForPct(pred.market.SPY_ret_1)}
                  </span>
                  <span className="px-2 py-1 rounded-lg border border-zinc-800 bg-zinc-950">
                    QQQ {badgeForPct(pred.market.QQQ_ret_1)}
                  </span>
                  {pred.cache?.ttl_sec ? (
                    <span className="px-2 py-1 rounded-lg border border-zinc-800 bg-zinc-950 text-zinc-400">
                      Cached: {pred.cache.hit ? "yes" : "no"} (TTL{" "}
                      {pred.cache.ttl_sec}s)
                    </span>
                  ) : null}
                </>
              ) : (
                <span className="px-2 py-1 rounded-lg border border-zinc-800 bg-zinc-950 text-zinc-500">
                  run prediction to load
                </span>
              )}
            </div>

            <div className="mt-4 h-[340px] min-w-0 w-full rounded-2xl border border-zinc-800 bg-zinc-950 p-3">
              {candles.length === 0 ? (
                <div className="h-full flex items-center justify-center text-sm text-zinc-500">
                  Run a prediction to load candlestick chart
                </div>
              ) : (
                <CandleChart
                  candles={candles.map(({ time, open, high, low, close }) => ({
                    time,
                    open,
                    high,
                    low,
                    close,
                  }))}
                />
              )}
            </div>

            <div className="mt-3 text-xs text-zinc-500">
              Source: {pred?.source ?? "—"} • Timeframe: {timeframe} • Last 200
              candles
            </div>
          </div>

          <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-5">
            <h2 className="text-sm font-medium text-zinc-300">Forecast</h2>

            {!pred ? (
              <div className="mt-4 text-sm text-zinc-500">
                Run a prediction to see results.
              </div>
            ) : (
              <div className="mt-4 space-y-4">
                <div>
                  <div className="text-xs text-zinc-500">Symbol</div>
                  <div className="text-lg font-semibold">{pred.symbol}</div>
                  <div className="text-xs text-zinc-500 mt-1">
                    Timeframe: {pred.timeframe}
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-3">
                    <div className="text-xs text-zinc-500">Last close</div>
                    <div className="text-lg font-semibold">
                      ${pred.last_close.toFixed(2)}
                    </div>
                  </div>
                  <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-3">
                    <div className="text-xs text-zinc-500">Predicted next</div>
                    <div className="text-lg font-semibold">
                      ${pred.prediction.toFixed(2)}
                    </div>
                  </div>
                </div>

                <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-3">
                  <div className="text-xs text-zinc-500">Expected range</div>
                  <div className="text-base font-semibold">
                    ${pred.range_low.toFixed(2)} — ${pred.range_high.toFixed(2)}
                  </div>
                  <div className="mt-1 text-xs text-zinc-500">
                    Confidence: {(pred.confidence * 100).toFixed(0)}%
                    {changePct !== null && (
                      <span className="ml-2">
                        • Change: {changePct >= 0 ? "+" : ""}
                        {changePct.toFixed(2)}%
                      </span>
                    )}
                  </div>
                </div>

                <div className="text-xs text-zinc-500">
                  Model: RandomForest baseline (with SPY/QQQ context) • Trained on{" "}
                  {pred.data_points} candles
                </div>
              </div>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}
