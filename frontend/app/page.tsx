"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import CandleChart from "../components/CandleChart";
import RiskMeter from "../components/RiskMeter";
import LoadingSteps from "../components/LoadingSteps";

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
  backtest?: {
    method?: string;
    summary?: {
      ok?: boolean;
      points?: number;
      mae?: number;
      mape?: number;
      direction_accuracy?: number;
    };
  };
  cache?: { hit?: boolean; ttl_sec?: number; model_hit?: boolean; tune_hit?: boolean };
  // If you later add volatility to response, we’ll use it. For now we estimate from range width.
};

type HistoryResponse = {
  symbol: string;
  timeframe: "daily" | "weekly";
  candles: { time: string; open: number; high: number; low: number; close: number; volume: number }[];
};

type SymbolsResponse = {
  items: { symbol: string; symbol_alt?: string | null; name: string; sector?: string }[];
  source: string;
  count: number;
  error?: string | null;
};

const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE?.replace(/\/$/, "") || "http://localhost:8000";

function fmtMoney(v: number) {
  return `$${v.toFixed(2)}`;
}

function pct(a: number, b: number) {
  if (!b) return 0;
  return ((a - b) / b) * 100;
}

function badgeTone(p: number) {
  return p >= 0
    ? "border-emerald-700 bg-emerald-950/40 text-emerald-200"
    : "border-red-700 bg-red-950/40 text-red-200";
}

export default function Page() {
  const [symbol, setSymbol] = useState("AAPL");
  const [timeframe, setTimeframe] = useState<"daily" | "weekly">("daily");

  const [loading, setLoading] = useState(false);
  const [phase, setPhase] = useState(0);
  const phaseTimer = useRef<number | null>(null);

  const [pred, setPred] = useState<PredictResponse | null>(null);
  const [hist, setHist] = useState<HistoryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Symbols dropdown
  const [symbols, setSymbols] = useState<SymbolsResponse["items"]>([]);
  const [symbolsLoading, setSymbolsLoading] = useState(true);
  const [symbolsError, setSymbolsError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const candles = useMemo(() => hist?.candles ?? [], [hist]);

  // Derived metrics
  const changePct = pred ? pct(pred.prediction, pred.last_close) : null;

  // Estimate a volatility-like value from range width (until backend returns vol explicitly)
  const estVol = useMemo(() => {
    if (!pred) return 0.015;
    const mid = (pred.range_low + pred.range_high) / 2;
    const width = Math.max(0, pred.range_high - pred.range_low);
    return mid ? Math.min(0.15, Math.max(0.005, (width / mid) / 2)) : 0.02;
  }, [pred]);

  // Fetch SP500 symbols once
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setSymbolsLoading(true);
      setSymbolsError(null);
      try {
        const res = await fetch(`${API_BASE}/symbols/sp500?limit=2000`, { cache: "no-store" });
        if (!res.ok) throw new Error(`Symbols API error: ${res.status}`);
        const j = (await res.json()) as SymbolsResponse;
        if (!cancelled) {
          setSymbols(j.items ?? []);
          if (j.source === "fallback") {
            setSymbolsError(j.error || "Symbols fell back to a small list.");
          }
        }
      } catch (e: any) {
        if (!cancelled) setSymbolsError(e?.message ?? "Failed to load symbols");
      } finally {
        if (!cancelled) setSymbolsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return symbols.slice(0, 30);
    const matches = symbols.filter((it) => {
      const s = it.symbol.toLowerCase();
      const n = (it.name || "").toLowerCase();
      return s.includes(q) || n.includes(q);
    });
    return matches.slice(0, 30);
  }, [symbols, query]);

  function startPhases() {
    setPhase(0);
    if (phaseTimer.current) window.clearInterval(phaseTimer.current);
    let p = 0;
    phaseTimer.current = window.setInterval(() => {
      p = Math.min(4, p + 1);
      setPhase(p);
      if (p >= 4 && phaseTimer.current) window.clearInterval(phaseTimer.current);
    }, 650);
  }

  function stopPhases() {
    if (phaseTimer.current) window.clearInterval(phaseTimer.current);
    phaseTimer.current = null;
  }

  async function run() {
    const s = symbol.trim().toUpperCase();
    if (!s) return;

    setLoading(true);
    setError(null);
    startPhases();

    try {
      const [predRes, histRes] = await Promise.all([
        fetch(`${API_BASE}/predict`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ symbol: s, timeframe }),
        }),
        fetch(`${API_BASE}/history/${encodeURIComponent(s)}?timeframe=${timeframe}&points=220`),
      ]);

      if (!predRes.ok) throw new Error(`Predict API error: ${predRes.status}`);
      if (!histRes.ok) throw new Error(`History API error: ${histRes.status}`);

      const predJson = (await predRes.json()) as PredictResponse;
      const histJson = (await histRes.json()) as HistoryResponse;

      setPred(predJson);
      setHist(histJson);
    } catch (e: any) {
      setError(e?.message ?? `Network error (is backend running at ${API_BASE} ?)`);
      setPred(null);
      setHist(null);
    } finally {
      stopPhases();
      setLoading(false);
    }
  }

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100">
      <div className="max-w-6xl mx-auto px-6 py-8">
        {/* Header */}
        <header className="flex flex-col gap-2">
          <div className="inline-flex items-center gap-2 text-xs text-zinc-400">
            <span className="rounded-full border border-zinc-800 bg-zinc-900/40 px-3 py-1">
              US-only • Free data (Stooq)
            </span>
            <span className="rounded-full border border-zinc-800 bg-zinc-900/40 px-3 py-1">
              Not financial advice
            </span>
          </div>

          <h1 className="text-3xl md:text-4xl font-semibold tracking-tight">
            Stock Price Predictor
          </h1>

          <p className="text-sm text-zinc-400 max-w-3xl">
            A clean demo that fetches free market data, compares it to SPY/QQQ, runs a baseline model, and shows a forecast with backtest metrics.
          </p>
        </header>

        {/* Controls */}
        <section className="mt-7 grid grid-cols-1 lg:grid-cols-12 gap-4">
          <div className="lg:col-span-8 rounded-2xl border border-zinc-800 bg-zinc-900/40 p-5">
            <div className="flex flex-col gap-3">
              <div className="flex flex-col md:flex-row md:items-end gap-3">
                {/* Searchable dropdown */}
                <div className="flex-1">
                  <label className="text-xs text-zinc-500">Stock (S&P 500)</label>
                  <input
                    className="mt-2 w-full rounded-xl bg-zinc-950 border border-zinc-800 px-4 py-3 outline-none focus:ring-2 focus:ring-zinc-600"
                    value={query || symbol}
                    onChange={(e) => {
                      setQuery(e.target.value);
                      setSymbol(e.target.value.toUpperCase());
                    }}
                    placeholder="Type ticker or company name (e.g., AAPL / Apple)"
                  />
                  <div className="mt-2 text-[11px] text-zinc-500">
                    {symbolsLoading
                      ? "Loading symbols…"
                      : symbolsError
                        ? `Symbols issue: ${symbolsError} (you can still type a ticker)`
                        : `Loaded ${symbols.length} symbols. Start typing to search.`}
                  </div>

                  {/* Dropdown */}
                  <div className="mt-2 max-h-64 overflow-auto rounded-xl border border-zinc-800 bg-zinc-950">
                    {filtered.map((it) => (
                      <button
                        key={it.symbol}
                        onClick={() => {
                          setSymbol(it.symbol);
                          setQuery("");
                        }}
                        className="w-full text-left px-4 py-2 hover:bg-zinc-900/60 flex items-center justify-between"
                      >
                        <span className="text-sm text-zinc-200">
                          {it.symbol} <span className="text-zinc-500">— {it.name}</span>
                        </span>
                        {it.sector ? (
                          <span className="text-[11px] text-zinc-500">{it.sector}</span>
                        ) : null}
                      </button>
                    ))}
                    {!symbolsLoading && filtered.length === 0 && (
                      <div className="px-4 py-3 text-sm text-zinc-500">No matches.</div>
                    )}
                  </div>
                </div>

                {/* Timeframe */}
                <div className="w-full md:w-44">
                  <label className="text-xs text-zinc-500">Timeframe</label>
                  <select
                    className="mt-2 w-full rounded-xl bg-zinc-950 border border-zinc-800 px-3 py-3 outline-none focus:ring-2 focus:ring-zinc-600"
                    value={timeframe}
                    onChange={(e) => setTimeframe(e.target.value as any)}
                  >
                    <option value="daily">Daily</option>
                    <option value="weekly">Weekly</option>
                  </select>
                </div>

                {/* Run */}
                <div className="w-full md:w-auto">
                  <button
                    onClick={run}
                    disabled={loading}
                    className="w-full rounded-xl px-6 py-3 bg-zinc-100 text-zinc-900 font-semibold hover:bg-white disabled:opacity-60"
                  >
                    {loading ? "Working…" : "Predict"}
                  </button>
                  <div className="mt-2 text-[11px] text-zinc-500">
                    API: {API_BASE}
                  </div>
                </div>
              </div>

              {error && (
                <div className="rounded-xl border border-red-800 bg-red-950/40 p-4 text-sm text-red-200">
                  {error}
                </div>
              )}

              {/* Loading steps */}
              {loading && <LoadingSteps phase={phase} />}

              {/* Chart */}
              <div className="mt-2 rounded-2xl border border-zinc-800 bg-zinc-950 p-3">
                <div className="flex items-center justify-between px-1 pb-2">
                  <div className="text-xs text-zinc-500">
                    Candlestick chart (last {candles.length || 0} candles)
                  </div>
                  {pred && (
                    <div className="text-[11px] text-zinc-500">
                      Model cache: {pred.cache?.model_hit ? "hit" : "miss"} • Tune:{" "}
                      {pred.cache?.tune_hit ? "hit" : "miss"}
                    </div>
                  )}
                </div>

                <div className="h-[360px] min-w-0 w-full rounded-xl overflow-hidden">
                  {candles.length === 0 ? (
                    <div className="h-full flex items-center justify-center text-sm text-zinc-500">
                      Pick a symbol and click <span className="mx-1 font-semibold text-zinc-300">Predict</span> to load the chart.
                    </div>
                  ) : (
                    <CandleChart
                      candles={candles.map(({ time, open, high, low, close }) => ({
                        time, open, high, low, close,
                      }))}
                    />
                  )}
                </div>

                {pred && (
                  <div className="mt-3 grid grid-cols-1 md:grid-cols-3 gap-3">
                    <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-3">
                      <div className="text-xs text-zinc-500">Last close</div>
                      <div className="text-lg font-semibold">{fmtMoney(pred.last_close)}</div>
                    </div>

                    <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-3">
                      <div className="text-xs text-zinc-500">Predicted next</div>
                      <div className="text-lg font-semibold">{fmtMoney(pred.prediction)}</div>
                      {changePct !== null && (
                        <div className={`mt-2 inline-flex rounded-lg border px-2 py-1 text-xs ${badgeTone(changePct)}`}>
                          {changePct >= 0 ? "+" : ""}
                          {changePct.toFixed(2)}%
                        </div>
                      )}
                    </div>

                    <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-3">
                      <div className="text-xs text-zinc-500">Expected range</div>
                      <div className="text-base font-semibold">
                        {fmtMoney(pred.range_low)} — {fmtMoney(pred.range_high)}
                      </div>
                      <div className="mt-1 text-xs text-zinc-500">
                        Confidence {(pred.confidence * 100).toFixed(0)}%
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Right rail */}
          <div className="lg:col-span-4 space-y-4">
            {/* Market context */}
            <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-5">
              <h2 className="text-sm font-semibold text-zinc-200">Market context</h2>
              <p className="mt-1 text-xs text-zinc-500">
                Quick snapshot of SPY and QQQ moves.
              </p>

              {!pred ? (
                <div className="mt-4 text-sm text-zinc-500">Run a prediction to load market context.</div>
              ) : (
                <div className="mt-4 grid grid-cols-2 gap-3">
                  <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-3">
                    <div className="text-xs text-zinc-500">SPY</div>
                    <div className="text-base font-semibold">{fmtMoney(pred.market.SPY_last_close)}</div>
                    <div className={`mt-2 inline-flex rounded-lg border px-2 py-1 text-xs ${badgeTone(pred.market.SPY_ret_1)}`}>
                      {pred.market.SPY_ret_1 >= 0 ? "+" : ""}
                      {pred.market.SPY_ret_1.toFixed(2)}%
                    </div>
                  </div>
                  <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-3">
                    <div className="text-xs text-zinc-500">QQQ</div>
                    <div className="text-base font-semibold">{fmtMoney(pred.market.QQQ_last_close)}</div>
                    <div className={`mt-2 inline-flex rounded-lg border px-2 py-1 text-xs ${badgeTone(pred.market.QQQ_ret_1)}`}>
                      {pred.market.QQQ_ret_1 >= 0 ? "+" : ""}
                      {pred.market.QQQ_ret_1.toFixed(2)}%
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Risk meter */}
            <RiskMeter vol={estVol} />

            {/* Backtest */}
            <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-5">
              <h2 className="text-sm font-semibold text-zinc-200">Backtest</h2>
              <p className="mt-1 text-xs text-zinc-500">
                Walk-forward evaluation from the backend.
              </p>

              {!pred?.backtest?.summary ? (
                <div className="mt-4 text-sm text-zinc-500">Run a prediction to see backtest metrics.</div>
              ) : (
                <div className="mt-4 grid grid-cols-2 gap-3">
                  <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-3">
                    <div className="text-xs text-zinc-500">Direction accuracy</div>
                    <div className="text-lg font-semibold">
                      {Math.round((pred.backtest.summary.direction_accuracy || 0) * 100)}%
                    </div>
                    <div className="mt-1 text-[11px] text-zinc-500">
                      over {pred.backtest.summary.points ?? "—"} steps
                    </div>
                  </div>

                  <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-3">
                    <div className="text-xs text-zinc-500">Avg error (MAE)</div>
                    <div className="text-lg font-semibold">
                      {pred.backtest.summary.mae ? fmtMoney(pred.backtest.summary.mae) : "—"}
                    </div>
                    <div className="mt-1 text-[11px] text-zinc-500">
                      MAPE {pred.backtest.summary.mape ? (pred.backtest.summary.mape * 100).toFixed(2) + "%" : "—"}
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* News placeholder area (keeps page feeling alive) */}
            <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-5">
              <h2 className="text-sm font-semibold text-zinc-200">Market news</h2>
              <p className="mt-1 text-xs text-zinc-500">
                Headlines and catalysts (we’ll wire this to your /news endpoint).
              </p>

              <div className="mt-4 space-y-3">
                {[1, 2, 3].map((i) => (
                  <div key={i} className="rounded-xl border border-zinc-800 bg-zinc-950 p-3">
                    <div className="h-3 w-3/4 rounded bg-zinc-800/70" />
                    <div className="mt-2 h-3 w-1/2 rounded bg-zinc-800/40" />
                    <div className="mt-3 h-3 w-full rounded bg-zinc-800/30" />
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* Footer */}
        <footer className="mt-10 text-xs text-zinc-500">
          Built with Next.js + FastAPI • Data: Stooq • This tool is for education only.
        </footer>
      </div>
    </main>
  );
}
