"use client";

import { useMemo, useState } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";

type PredictResponse = {
  symbol: string;
  last_close: number;
  prediction: number;
  range_low: number;
  range_high: number;
  confidence: number;
  data_points: number;
  source: string;
};

type HistoryResponse = {
  symbol: string;
  points: { date: string; close: number }[];
};

export default function Home() {
  const [symbol, setSymbol] = useState("AAPL");
  const [loading, setLoading] = useState(false);
  const [pred, setPred] = useState<PredictResponse | null>(null);
  const [hist, setHist] = useState<HistoryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const chartData = useMemo(() => {
  if (!hist) return [];

  const data = [...hist.points];

  if (pred) {
    data.push({
      date: "Prediction",
      close: pred.prediction,
      isPrediction: true,
    } as any);
  }

  return data;
}, [hist, pred]);


  async function run() {
    const s = symbol.trim().toUpperCase();
    if (!s) return;

    setLoading(true);
    setError(null);

    try {
      const [predRes, histRes] = await Promise.all([
        fetch("http://localhost:8000/predict", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ symbol: s }),
        }),
        fetch(`http://localhost:8000/history/${encodeURIComponent(s)}?days=200`),
      ]);

      if (!predRes.ok) throw new Error(`Predict API error: ${predRes.status}`);
      if (!histRes.ok) throw new Error(`History API error: ${histRes.status}`);

      const predJson = (await predRes.json()) as PredictResponse;
      const histJson = (await histRes.json()) as HistoryResponse;

      setPred(predJson);
      setHist(histJson);
    } catch (e: any) {
      setError(e?.message ?? "Something went wrong");
      setPred(null);
      setHist(null);
    } finally {
      setLoading(false);
    }
  }

  const changePct =
    pred ? ((pred.prediction - pred.last_close) / pred.last_close) * 100 : null;

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100">
      <div className="max-w-5xl mx-auto p-6">
        <header className="flex flex-col gap-2">
          <h1 className="text-3xl font-semibold tracking-tight">
            Stock Price Predictor
          </h1>
          <p className="text-sm text-zinc-400 max-w-2xl">
            Forecasting demo using free daily market data + a baseline ML model.
            Not financial advice.
          </p>
        </header>

        <section className="mt-6 grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="md:col-span-2 rounded-2xl border border-zinc-800 bg-zinc-900/40 p-5">
            <div className="flex flex-col sm:flex-row gap-3 sm:items-center sm:justify-between">
              <div className="flex gap-3 w-full">
                <input
                  className="flex-1 rounded-xl bg-zinc-950 border border-zinc-800 px-4 py-3 outline-none focus:ring-2 focus:ring-zinc-600"
                  value={symbol}
                  onChange={(e) => setSymbol(e.target.value)}
                  placeholder="Ticker (e.g., AAPL)"
                />
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

            <div className="mt-5 h-[320px] rounded-2xl border border-zinc-800 bg-zinc-950 p-3">
              {chartData.length === 0 ? (
                <div className="h-full flex items-center justify-center text-sm text-zinc-500">
                  Run a prediction to load chart
                </div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={chartData}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="date" hide />
                    <YAxis
                      domain={["auto", "auto"]}
                      tick={{ fontSize: 12 }}
                      width={60}
                    />
                    <Tooltip
                      formatter={(v: any) => [`$${Number(v).toFixed(2)}`, "Close"]}
                      labelFormatter={(l) => `Date: ${l}`}
                    />
                    <Line
  type="monotone"
  dataKey="close"
  dot={(props: any) => {
    if (props.payload?.isPrediction) {
      return (
        <circle
          cx={props.cx}
          cy={props.cy}
          r={6}
          fill="#22c55e"
          stroke="white"
          strokeWidth={2}
        />
      );
    }
    return null;
  }}
  stroke="#3b82f6"
  strokeWidth={2}
/>

                  </LineChart>
                </ResponsiveContainer>
              )}
            </div>

            <div className="mt-3 text-xs text-zinc-500">
              Data source: {pred?.source ?? "—"} • Daily closes • Last 200 trading
              days
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
                    Confidence: {(pred.confidence * 100).toFixed(0)}%{" "}
                    {changePct !== null && (
                      <span className="ml-2">
                        • Change: {changePct >= 0 ? "+" : ""}
                        {changePct.toFixed(2)}%
                      </span>
                    )}
                  </div>
                </div>

                <div className="text-xs text-zinc-500">
                  Model: RandomForest baseline • Trained on {pred.data_points}{" "}
                  data points
                </div>
              </div>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}
