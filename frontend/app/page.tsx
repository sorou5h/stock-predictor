"use client";

import { useEffect, useMemo, useState } from "react";
import CandleChart from "../components/CandleChart";

/**
 * Deployment-ready API base:
 * - Local dev fallback: http://localhost:8001
 * - Vercel prod: set NEXT_PUBLIC_API_BASE_URL to your Render backend URL
 */
const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:8001";

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

type NewsItem = {
  id: string;
  title: string;
  source: string;
  time: string;
  summary: string;
  url?: string | null;
};

type NewsResponse = {
  mode: "market" | "ticker";
  symbol?: string | null;
  items: NewsItem[];
  source: string;
};

type SymbolItem = {
  symbol: string;
  symbol_alt?: string | null;
  name: string;
  sector?: string;
};

type SymbolsResponse = {
  items: SymbolItem[];
  source: string;
  count: number;
  cache_ttl_sec: number;
};

function Skeleton({ className = "" }: { className?: string }) {
  return (
    <div
      className={`animate-pulse rounded-lg bg-zinc-800/60 ${className}`}
      aria-hidden="true"
    />
  );
}

function fmtMoney(n: number) {
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function clamp01(x: number) {
  return Math.max(0, Math.min(1, x));
}

export default function Home() {
  const [symbol, setSymbol] = useState("AAPL");
  const [timeframe, setTimeframe] = useState<"daily" | "weekly">("daily");
  const [loading, setLoading] = useState(false);
  const [loadingMsg, setLoadingMsg] = useState<string | null>(null);
  const [pred, setPred] = useState<PredictResponse | null>(null);
  const [hist, setHist] = useState<HistoryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [backendOk, setBackendOk] = useState<boolean | null>(null);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);

  const [newsTab, setNewsTab] = useState<"market" | "ticker">("market");
  const [newsLoading, setNewsLoading] = useState(false);
  const [newsError, setNewsError] = useState<string | null>(null);
  const [news, setNews] = useState<NewsResponse | null>(null);

  const [symbols, setSymbols] = useState<SymbolItem[]>([]);
  const [symbolsLoading, setSymbolsLoading] = useState(false);
  const [symbolsError, setSymbolsError] = useState<string | null>(null);

  const [symbolQuery, setSymbolQuery] = useState("AAPL");
  const [comboOpen, setComboOpen] = useState(false);

  const candles = useMemo(() => hist?.candles ?? [], [hist]);

  useEffect(() => {
    const t = hist?.candles?.[hist.candles.length - 1]?.time;
    setLastUpdated(t ?? null);
  }, [hist]);

  useEffect(() => {
    setSymbolQuery(symbol);
  }, [symbol]);

  async function loadNews(tab: "market" | "ticker", sym: string) {
    const s = sym.trim().toUpperCase();
    if (!s) return;

    setNewsLoading(true);
    setNewsError(null);

    try {
      const url =
        tab === "market"
          ? `${API_BASE}/news?mode=market&limit=6`
          : `${API_BASE}/news?mode=ticker&symbol=${encodeURIComponent(s)}&limit=6`;

      const res = await fetch(url);
      if (!res.ok) throw new Error(`News API error: ${res.status}`);

      const json = (await res.json()) as NewsResponse;
      setNews(json);
    } catch (e: any) {
      setNewsError(e?.message ?? "Failed to load news");
      setNews(null);
    } finally {
      setNewsLoading(false);
    }
  }

  // Warm up backend + load initial market news + S&P 500 symbol list
  useEffect(() => {
    fetch(`${API_BASE}/health`)
      .then((r) => setBackendOk(r.ok))
      .catch(() => setBackendOk(false));

    // Load S&P 500 symbols for searchable dropdown
    (async () => {
      setSymbolsLoading(true);
      setSymbolsError(null);
      try {
        const res = await fetch(`${API_BASE}/symbols/sp500?limit=2000`);
        if (!res.ok) throw new Error(`Symbols API error: ${res.status}`);
        const json = (await res.json()) as SymbolsResponse;
        setSymbols(json.items ?? []);
      } catch (e: any) {
        setSymbolsError(e?.message ?? "Failed to load symbols");
        setSymbols([]);
      } finally {
        setSymbolsLoading(false);
      }
    })();

    loadNews("market", symbol);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const filteredSymbols = useMemo(() => {
    const q = symbolQuery.trim().toLowerCase();
    if (!q) return symbols.slice(0, 25);

    const matches = symbols.filter((it) => {
      return (
        it.symbol.toLowerCase().includes(q) ||
        (it.symbol_alt ?? "").toLowerCase().includes(q) ||
        it.name.toLowerCase().includes(q)
      );
    });

    return matches.slice(0, 25);
  }, [symbols, symbolQuery]);

  // When tab changes, reload news for the active tab
  useEffect(() => {
    loadNews(newsTab, symbol);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newsTab]);

  // Also reload ticker news when the symbol changes (only if the ticker tab is active)
  useEffect(() => {
    if (newsTab === "ticker") {
      loadNews("ticker", symbol);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol]);

  async function run() {
    const s = symbol.trim().toUpperCase();
    if (!s) return;

    setLoading(true);
    setError(null);

    const startedAt = Date.now();

    // Friendly rotating status messages
    const steps = [
      "Waking up the AI server…",
      "Downloading the latest market data…",
      "Analyzing past prices…",
      "Comparing against SPY & QQQ…",
      "Training the model (cached for speed)…",
      "Predicting the future outcome…",
      "Rendering chart & results…",
    ];

    setLoadingMsg(steps[0]);
    let i = 0;
    const timer = setInterval(() => {
      i = (i + 1) % steps.length;
      setLoadingMsg(steps[i]);
    }, 1200);

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
      // Keep the message visible briefly so it doesn't flash too fast
      const elapsed = Date.now() - startedAt;
      const minShowMs = 900;
      if (elapsed < minShowMs) {
        await new Promise((r) => setTimeout(r, minShowMs - elapsed));
      }

      clearInterval(timer);
      setLoading(false);
      setLoadingMsg(null);
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
          <div className="mt-2 flex flex-wrap gap-2 text-xs">
            <span className="px-2 py-1 rounded-lg border border-zinc-800 bg-zinc-950 text-zinc-300">
              Backend: {backendOk === null ? "checking…" : backendOk ? "online" : "offline"}
            </span>
            <span className="px-2 py-1 rounded-lg border border-zinc-800 bg-zinc-950 text-zinc-300">
              Data: {pred?.source ?? "stooq"}
            </span>
            <span className="px-2 py-1 rounded-lg border border-zinc-800 bg-zinc-950 text-zinc-300">
              Mode: {timeframe}
            </span>
            <span className="px-2 py-1 rounded-lg border border-zinc-800 bg-zinc-950 text-zinc-300">
              Updated: {lastUpdated ?? "—"}
            </span>
            <span className="px-2 py-1 rounded-lg border border-zinc-800 bg-zinc-950 text-zinc-300">
              Cache: {pred?.cache?.hit ? "hit" : pred ? "miss" : "—"}
            </span>
          </div>
        </header>

        <section className="mt-6 grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="md:col-span-2 rounded-2xl border border-zinc-800 bg-zinc-900/40 p-5">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex gap-3 w-full">
                <div className="relative flex-1">
                  <input
                    className="w-full rounded-xl bg-zinc-950 border border-zinc-800 px-4 py-3 outline-none focus:ring-2 focus:ring-zinc-600"
                    value={symbolQuery}
                    onChange={(e) => {
                      setSymbolQuery(e.target.value);
                      setComboOpen(true);
                    }}
                    onFocus={() => setComboOpen(true)}
                    onBlur={() => {
                      // small delay so click selection works
                      setTimeout(() => setComboOpen(false), 150);
                      // keep symbol in sync with what user typed (manual fallback)
                      setSymbol(symbolQuery.trim().toUpperCase());
                    }}
                    placeholder={symbolsLoading ? "Loading S&P 500…" : "Search S&P 500 (e.g., Apple or AAPL)"}
                    aria-label="Search ticker"
                  />

                  {comboOpen && (
                    <div className="absolute z-20 mt-2 w-full rounded-xl border border-zinc-800 bg-zinc-950 shadow-lg overflow-hidden">
                      <div className="max-h-72 overflow-auto">
                        {symbolsError ? (
                          <div className="p-3 text-sm text-red-200">{symbolsError}</div>
                        ) : symbolsLoading ? (
                          <div className="p-3 text-sm text-zinc-400">Loading symbols…</div>
                        ) : filteredSymbols.length === 0 ? (
                          <div className="p-3 text-sm text-zinc-500">No matches. You can still type a ticker manually.</div>
                        ) : (
                          filteredSymbols.map((it) => (
                            <button
                              key={it.symbol}
                              type="button"
                              onMouseDown={(e) => e.preventDefault()}
                              onClick={() => {
                                // Prefer symbol_alt for providers that use '-' instead of '.'
                                const pick = (it.symbol_alt ?? it.symbol).toUpperCase();
                                setSymbol(pick);
                                setSymbolQuery(pick);
                                setComboOpen(false);
                              }}
                              className="w-full text-left px-4 py-3 hover:bg-zinc-900/60 border-b border-zinc-900/50 last:border-b-0"
                            >
                              <div className="flex items-center justify-between gap-3">
                                <div className="min-w-0">
                                  <div className="text-sm font-semibold text-zinc-100 truncate">
                                    {it.symbol_alt ?? it.symbol}
                                    <span className="ml-2 text-xs font-normal text-zinc-400 truncate">{it.name}</span>
                                  </div>
                                  {it.sector ? (
                                    <div className="mt-1 text-xs text-zinc-500 truncate">{it.sector}</div>
                                  ) : null}
                                </div>
                                <span className="text-xs text-zinc-400">Select</span>
                              </div>
                            </button>
                          ))
                        )}
                      </div>
                    </div>
                  )}

                  <div className="mt-1 text-[11px] text-zinc-500">
                    {symbolsLoading ? "Loading symbols…" : `Pick from S&P 500 or type any ticker manually.`}
                  </div>
                </div>

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

            {loading && (
              <div className="mt-3 text-sm text-zinc-400">
                {loadingMsg ?? "Working…"}
              </div>
            )}

            {error && (
              <div className="mt-4 rounded-xl border border-red-800 bg-red-950/40 p-4 text-sm text-red-200">
                {error}
              </div>
            )}

            {/* Key stats */}
            <div className="mt-4 grid grid-cols-2 md:grid-cols-4 gap-3">
              {loading ? (
                <>
                  <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-3">
                    <Skeleton className="h-3 w-20" />
                    <Skeleton className="mt-2 h-6 w-24" />
                  </div>
                  <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-3">
                    <Skeleton className="h-3 w-24" />
                    <Skeleton className="mt-2 h-6 w-28" />
                  </div>
                  <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-3">
                    <Skeleton className="h-3 w-16" />
                    <Skeleton className="mt-2 h-6 w-20" />
                  </div>
                  <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-3">
                    <Skeleton className="h-3 w-20" />
                    <Skeleton className="mt-2 h-2 w-full" />
                    <Skeleton className="mt-2 h-3 w-12" />
                  </div>
                </>
              ) : pred ? (
                <>
                  <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-3">
                    <div className="text-xs text-zinc-500">Last close</div>
                    <div className="mt-1 text-lg font-semibold">${fmtMoney(pred.last_close)}</div>
                  </div>
                  <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-3">
                    <div className="text-xs text-zinc-500">Predicted next</div>
                    <div className="mt-1 text-lg font-semibold">${fmtMoney(pred.prediction)}</div>
                  </div>
                  <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-3">
                    <div className="text-xs text-zinc-500">Change</div>
                    <div className="mt-1 text-lg font-semibold">
                      {changePct === null ? "—" : (
                        <span className={changePct >= 0 ? "text-emerald-200" : "text-red-200"}>
                          {changePct >= 0 ? "+" : ""}{changePct.toFixed(2)}%
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-3">
                    <div className="text-xs text-zinc-500">Confidence</div>
                    <div className="mt-2 h-2 w-full rounded-full bg-zinc-800">
                      <div
                        className="h-2 rounded-full bg-zinc-200"
                        style={{ width: `${clamp01(pred.confidence) * 100}%` }}
                      />
                    </div>
                    <div className="mt-2 text-xs text-zinc-400">
                      {(pred.confidence * 100).toFixed(0)}%
                    </div>
                  </div>
                </>
              ) : (
                <div className="col-span-2 md:col-span-4 rounded-xl border border-zinc-800 bg-zinc-950 p-3 text-sm text-zinc-500">
                  Run a prediction to populate key stats.
                </div>
              )}
            </div>
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
                  Run a prediction to load the candlestick chart (last 200 candles).
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
                <details className="rounded-xl border border-zinc-800 bg-zinc-950 p-3">
                  <summary className="cursor-pointer text-sm text-zinc-200 select-none">
                    About this prediction
                  </summary>
                  <div className="mt-3 space-y-3 text-sm text-zinc-400">
                    <p>
                      This is a demo model trained on historical candles using technical features
                      (returns, moving averages, volatility, volume signals) plus market context
                      from SPY and QQQ.
                    </p>
                    <ul className="space-y-1">
                      <li>• Daily = next trading day close</li>
                      <li>• Weekly = next weekly close (aggregated candles)</li>
                      <li>• Confidence is a rough stability score, not a guarantee</li>
                    </ul>
                    <p className="text-xs text-zinc-500">
                      Not financial advice.
                    </p>
                  </div>
                </details>
              </div>
            )}
          </div>
        </section>
        {/* News */}
        <section className="mt-6 rounded-2xl border border-zinc-800 bg-zinc-900/40 p-5">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-sm font-medium text-zinc-200">Market News</h2>
              <p className="text-xs text-zinc-500 mt-1">
                Latest headlines (US-only). Source: {news?.source ?? "—"}
              </p>
            </div>

            <div className="flex gap-2">
              <button
                onClick={() => setNewsTab("market")}
                className={`px-3 py-1.5 rounded-lg text-xs border transition ${
                  newsTab === "market"
                    ? "border-zinc-600 bg-zinc-950 text-zinc-100"
                    : "border-zinc-800 bg-zinc-900/30 text-zinc-400 hover:text-zinc-200"
                }`}
              >
                Market
              </button>
              <button
                onClick={() => setNewsTab("ticker")}
                className={`px-3 py-1.5 rounded-lg text-xs border transition ${
                  newsTab === "ticker"
                    ? "border-zinc-600 bg-zinc-950 text-zinc-100"
                    : "border-zinc-800 bg-zinc-900/30 text-zinc-400 hover:text-zinc-200"
                }`}
              >
                {symbol.trim().toUpperCase() || "Ticker"}
              </button>
            </div>
          </div>

          {newsError && (
            <div className="mt-4 rounded-xl border border-red-800 bg-red-950/40 p-4 text-sm text-red-200">
              {newsError}
            </div>
          )}

          <div className="mt-4 grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="md:col-span-2 space-y-3">
              {newsLoading ? (
                <>
                  {[0, 1, 2].map((k) => (
                    <div key={k} className="rounded-xl border border-zinc-800 bg-zinc-950 p-4">
                      <Skeleton className="h-4 w-40" />
                      <Skeleton className="mt-3 h-4 w-full" />
                      <Skeleton className="mt-2 h-4 w-5/6" />
                    </div>
                  ))}
                </>
              ) : (news?.items?.length ?? 0) === 0 ? (
                <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-4 text-sm text-zinc-500">
                  No news items.
                </div>
              ) : (
                news!.items.map((item) => (
                  <article
                    key={item.id}
                    className="rounded-xl border border-zinc-800 bg-zinc-950 p-4"
                  >
                    <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-500">
                      <span className="px-2 py-0.5 rounded-lg border border-zinc-800 bg-zinc-900/30">
                        {item.source}
                      </span>
                      {item.time ? (
                        <>
                          <span>•</span>
                          <span>{item.time}</span>
                        </>
                      ) : null}
                    </div>

                    <h3 className="mt-2 text-sm font-semibold text-zinc-100">
                      {item.url ? (
                        <a
                          href={item.url}
                          target="_blank"
                          rel="noreferrer"
                          className="hover:underline"
                        >
                          {item.title}
                        </a>
                      ) : (
                        item.title
                      )}
                    </h3>

                    {item.summary ? (
                      <p className="mt-2 text-sm text-zinc-400 leading-relaxed">
                        {item.summary}
                      </p>
                    ) : null}
                  </article>
                ))
              )}
            </div>

            <aside className="rounded-xl border border-zinc-800 bg-zinc-950 p-4">
              <h3 className="text-xs font-medium text-zinc-300">Tips</h3>
              <ul className="mt-3 space-y-2 text-sm text-zinc-400">
                <li>• Use Market news for macro context.</li>
                <li>• Use Ticker news to understand company-specific moves.</li>
                <li>• News can overwhelm technical signals short-term.</li>
              </ul>
              <button
                onClick={() => loadNews(newsTab, symbol)}
                disabled={newsLoading}
                className="mt-4 w-full rounded-xl px-4 py-2 bg-zinc-100 text-zinc-900 text-sm font-medium hover:bg-white disabled:opacity-60"
              >
                {newsLoading ? "Refreshing…" : "Refresh"}
              </button>
            </aside>
          </div>
        </section>
      </div>
    </main>
  );
}
