"use client";

import { useState } from "react";

type PredictResponse = {
  symbol: string;
  prediction: number;
  range_low: number;
  range_high: number;
  confidence: number;
};

export default function Home() {
  const [symbol, setSymbol] = useState("AAPL");
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<PredictResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function runPrediction() {
    setLoading(true);
    setError(null);
    setData(null);

    try {
      const res = await fetch("http://localhost:8000/predict", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol }),
      });

      if (!res.ok) throw new Error(`API error: ${res.status}`);
      const json = (await res.json()) as PredictResponse;
      setData(json);
    } catch (e: any) {
      setError(e?.message ?? "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100 flex items-center justify-center p-6">
      <div className="w-full max-w-xl rounded-2xl bg-zinc-900/60 border border-zinc-800 p-6 shadow-lg">
        <h1 className="text-2xl font-semibold">Stock Price Predictor</h1>
        <p className="text-sm text-zinc-400 mt-2">
          A forecasting demo (not financial advice). We’ll replace the dummy model with real market data + ML next.
        </p>

        <div className="mt-6 flex gap-3">
          <input
            className="flex-1 rounded-xl bg-zinc-950 border border-zinc-800 px-4 py-3 outline-none focus:ring-2 focus:ring-zinc-600"
            value={symbol}
            onChange={(e) => setSymbol(e.target.value)}
            placeholder="e.g., AAPL"
          />
          <button
            onClick={runPrediction}
            disabled={loading}
            className="rounded-xl px-5 py-3 bg-zinc-100 text-zinc-900 font-medium hover:bg-white disabled:opacity-60"
          >
            {loading ? "Running..." : "Predict"}
          </button>
        </div>

        {error && (
          <div className="mt-4 rounded-xl border border-red-800 bg-red-950/40 p-4 text-sm text-red-200">
            {error}
          </div>
        )}

        {data && (
          <div className="mt-6 rounded-2xl bg-zinc-950 border border-zinc-800 p-5">
            <div className="flex items-baseline justify-between">
              <div className="text-lg font-semibold">{data.symbol}</div>
              <div className="text-sm text-zinc-400">
                Confidence: {(data.confidence * 100).toFixed(0)}%
              </div>
            </div>

            <div className="mt-4 text-3xl font-semibold">
              ${data.prediction.toFixed(2)}
            </div>

            <div className="mt-2 text-sm text-zinc-400">
              Expected range: ${data.range_low.toFixed(2)} — ${data.range_high.toFixed(2)}
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
