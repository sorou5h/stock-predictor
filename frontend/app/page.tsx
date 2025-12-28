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

type AssetType = "stock" | "crypto";

type PredictResponse = {
  symbol?: string; // stocks
  pair?: string; // crypto
  timeframe: "daily" | "weekly" | "hourly";
  last_close: number;
  prediction: number;
  range_low: number;
  range_high: number;
  confidence: number;
  data_points: number;
  source: string;
  market?: {
    SPY_last_close: number;
    QQQ_last_close: number;
    SPY_ret_1: number; // percent
    QQQ_ret_1: number; // percent
  };
  cache?: { hit: boolean; ttl_sec: number };
};

type ForecastItem = {
  horizon: number;
  prediction: number;
  range_low: number;
  range_high: number;
  change_pct: number;
  confidence: number;
};

type ForecastResponse = {
  symbol?: string;
  pair?: string;
  timeframe: "daily" | "weekly" | "hourly";
  last_close: number;
  as_of: string;
  horizons: ForecastItem[];
  source: string;
};

type HistoryResponse = {
  symbol?: string;
  pair?: string;
  timeframe: "daily" | "weekly" | "hourly";
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

type CryptoSymbolItem = {
  pair: string; // e.g. BTC-USD
  name?: string | null;
};

type CryptoSymbolsResponse = {
  items: CryptoSymbolItem[];
  source: string;
};

type BacktestResponse = {
  symbol: string;
  timeframe: "daily" | "weekly";
  as_of: string;
  day_bucket: string;
  ok: boolean;
  metrics: {
    ok: boolean;
    points?: number;
    mae?: number;
    mape?: number;
    direction_accuracy?: number;
    reason?: string;
  };
  params: Record<string, any>;
  cache?: { ttl_sec: number; hit?: boolean; forced?: boolean };
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
  return n.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function clamp01(x: number) {
  return Math.max(0, Math.min(1, x));
}

function pct(a: number, b: number) {
  if (!b) return 0;
  return ((a - b) / b) * 100;
}

function safeNum(x: any, fallback = 0) {
  const n = Number(x);
  return Number.isFinite(n) ? n : fallback;
}

export default function Home() {
  const [symbol, setSymbol] = useState("AAPL");
  const [timeframe, setTimeframe] = useState<"daily" | "weekly">("daily");
  const [assetType, setAssetType] = useState<AssetType>("stock");
  const [loading, setLoading] = useState(false);
  const [loadingMsg, setLoadingMsg] = useState<string | null>(null);
  const [pred, setPred] = useState<PredictResponse | null>(null);
  const [hist, setHist] = useState<HistoryResponse | null>(null);
  const [forecast, setForecast] = useState<ForecastResponse | null>(null);

  // Backtest (accuracy)
  const [bt, setBt] = useState<BacktestResponse | null>(null);
  const [btLoading, setBtLoading] = useState(false);
  const [btError, setBtError] = useState<string | null>(null);

  // Live price ticker
  const [livePrice, setLivePrice] = useState<number | null>(null);
  const [liveChangePct, setLiveChangePct] = useState<number | null>(null);
  const [liveUpdatedAt, setLiveUpdatedAt] = useState<string | null>(null);
  const [liveLoading, setLiveLoading] = useState(false);
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

  const [cryptoSymbols, setCryptoSymbols] = useState<CryptoSymbolItem[]>([]);
  const [cryptoSymbolsLoading, setCryptoSymbolsLoading] = useState(false);
  const [cryptoSymbolsError, setCryptoSymbolsError] = useState<string | null>(
    null
  );

  const [symbolQuery, setSymbolQuery] = useState("AAPL");
  const [comboOpen, setComboOpen] = useState(false);

  const candles = useMemo(() => hist?.candles ?? [], [hist]);

  // ✅ NEW: technical snapshot (fills the empty space under chart)
  const technicals = useMemo(() => {
    const cs = candles ?? [];
    if (cs.length < 20) {
      return {
        ok: false,
        lastClose: null as number | null,
        sma20: null as number | null,
        sma50: null as number | null,
        rsi14: null as number | null,
        support: null as number | null,
        resistance: null as number | null,
        avgRangePct: null as number | null,
        lastChangePct: null as number | null,
        points: cs.length,
      };
    }

    const closes = cs.map((x) => safeNum(x.close));
    const lastClose = closes[closes.length - 1];

    function sma(period: number) {
      if (closes.length < period) return null;
      const slice = closes.slice(-period);
      const v = slice.reduce((a, b) => a + b, 0) / Math.max(1, slice.length);
      return Number.isFinite(v) ? v : null;
    }

    function rsi(period = 14) {
      if (closes.length < period + 1) return null;
      let gains = 0;
      let losses = 0;
      const start = closes.length - (period + 1);
      for (let i = start + 1; i < closes.length; i++) {
        const diff = closes[i] - closes[i - 1];
        if (diff >= 0) gains += diff;
        else losses += Math.abs(diff);
      }
      const avgGain = gains / period;
      const avgLoss = losses / period;
      if (avgLoss === 0) return 100;
      const rs = avgGain / avgLoss;
      const val = 100 - 100 / (1 + rs);
      return Number.isFinite(val) ? val : null;
    }

    const sma20 = sma(20);
    const sma50 = sma(50);
    const rsi14 = rsi(14);

    // Simple support/resistance from last 20 candles
    const lb = cs.slice(-20);
    const support = Math.min(...lb.map((x) => safeNum(x.low)));
    const resistance = Math.max(...lb.map((x) => safeNum(x.high)));

    // Avg range percent over last 20 candles
    const ranges = lb
      .map((x) => {
        const hi = safeNum(x.high);
        const lo = safeNum(x.low);
        const mid = (hi + lo) / 2;
        if (!mid) return null;
        return ((hi - lo) / mid) * 100;
      })
      .filter((x): x is number => typeof x === "number" && Number.isFinite(x));

    const avgRangePct = ranges.length
      ? ranges.reduce((a, b) => a + b, 0) / ranges.length
      : null;

    const prevClose = closes.length >= 2 ? closes[closes.length - 2] : lastClose;
    const lastChangePct = prevClose
      ? ((lastClose - prevClose) / prevClose) * 100
      : 0;

    return {
      ok: true,
      lastClose,
      sma20,
      sma50,
      rsi14,
      support,
      resistance,
      avgRangePct,
      lastChangePct,
      points: cs.length,
    };
  }, [candles]);

  const insights = useMemo(() => {
    const cs = candles ?? [];
    if (cs.length < 5) {
      return {
        ok: false,
        trendLabel: "—",
        trendTone: "neutral" as const,
        volPct: 0,
        hi: null as number | null,
        lo: null as number | null,
        volNow: null as number | null,
        volAvg: null as number | null,
        volTone: "neutral" as const,
        lookback: 0,
      };
    }

    const last = cs[cs.length - 1];
    const lastClose = safeNum(last.close);

    // Trend: compare last close vs close N candles ago
    const N = Math.min(20, cs.length - 1);
    const prevClose = safeNum(cs[cs.length - 1 - N].close, lastClose);
    const trendPct = pct(lastClose, prevClose);

    const trendTone =
      trendPct > 0.25
        ? ("good" as const)
        : trendPct < -0.25
        ? ("bad" as const)
        : ("neutral" as const);

    const trendLabel =
      trendPct > 0.25
        ? `Up (${trendPct.toFixed(2)}%)`
        : trendPct < -0.25
        ? `Down (${trendPct.toFixed(2)}%)`
        : `Flat (${trendPct.toFixed(2)}%)`;

    // Volatility: avg absolute % move over last N candles
    const slice = cs.slice(-N - 1);
    let sumAbs = 0;
    let count = 0;
    for (let i = 1; i < slice.length; i++) {
      const c = safeNum(slice[i].close);
      const p = safeNum(slice[i - 1].close);
      if (p) {
        sumAbs += Math.abs(((c - p) / p) * 100);
        count += 1;
      }
    }
    const volPct = count ? sumAbs / count : 0;

    // High/Low over last 52 candles (or available)
    const lookback = Math.min(52, cs.length);
    const lb = cs.slice(-lookback);
    const hi = Math.max(...lb.map((x) => safeNum(x.high)));
    const lo = Math.min(...lb.map((x) => safeNum(x.low)));

    // Volume now vs avg
    const volNow = safeNum(last.volume, 0);
    const volAvg =
      lb.reduce((acc, x) => acc + safeNum(x.volume, 0), 0) /
      Math.max(1, lb.length);

    const volTone =
      volNow > volAvg * 1.15
        ? ("good" as const)
        : volNow < volAvg * 0.85
        ? ("bad" as const)
        : ("neutral" as const);

    return {
      ok: true,
      trendLabel,
      trendTone,
      volPct,
      hi,
      lo,
      volNow,
      volAvg,
      volTone,
      lookback,
    };
  }, [candles]);

  // -------- API helpers (stock/crypto routing) --------
  function apiPath(p: string) {
    return `${API_BASE}${p}`;
  }

  function isCrypto() {
    return assetType === "crypto";
  }

  function normalizeCryptoPair(input: string) {
    const s = (input || "").trim().toUpperCase();
    if (!s) return "BTC-USD";
    if (s.includes("-")) return s;
    return `${s}-USD`;
  }

  function displaySymbol() {
    return (pred?.symbol ?? pred?.pair ?? symbol).toString().toUpperCase();
  }

  function predictUrl() {
    return apiPath(isCrypto() ? "/crypto/predict" : "/predict");
  }

  function forecastUrl() {
    return apiPath(isCrypto() ? "/crypto/forecast" : "/forecast");
  }

  function historyUrl(sym: string, tf: string, pts: number) {
    const base = isCrypto()
      ? `/crypto/history/${encodeURIComponent(sym)}`
      : `/history/${encodeURIComponent(sym)}`;
    return apiPath(`${base}?timeframe=${tf}&points=${pts}`);
  }

  function backtestUrl(sym: string, tf: string, force: boolean) {
    if (isCrypto()) return null;
    return apiPath(
      `/backtest/${encodeURIComponent(sym)}?timeframe=${tf}&force=${
        force ? "true" : "false"
      }`
    );
  }

  function symbolsUrl() {
    return apiPath("/symbols/sp500?limit=2000");
  }

  function cryptoSymbolsUrl() {
    return apiPath("/crypto/symbols?limit=500");
  }

  function newsUrl(tab: "market" | "ticker", sym: string) {
    const s = sym.trim().toUpperCase();
    if (tab === "market") return apiPath("/news?mode=market&limit=6");
    return apiPath(
      `/news?mode=ticker&symbol=${encodeURIComponent(s)}&limit=6`
    );
  }

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

    const actualTab: "market" | "ticker" =
      assetType === "crypto" && tab === "ticker" ? "market" : tab;

    setNewsLoading(true);
    setNewsError(null);

    try {
      const url = newsUrl(actualTab, s);
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

  // Warm up backend + load initial market news + BOTH symbol lists
  useEffect(() => {
    fetch(`${API_BASE}/health`)
      .then((r) => setBackendOk(r.ok))
      .catch(() => setBackendOk(false));

    // Load S&P 500 symbols
    (async () => {
      setSymbolsLoading(true);
      setSymbolsError(null);
      try {
        const res = await fetch(symbolsUrl());
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

    // Load crypto symbols
    (async () => {
      setCryptoSymbolsLoading(true);
      setCryptoSymbolsError(null);
      try {
        const res = await fetch(cryptoSymbolsUrl());
        if (!res.ok) throw new Error(`Crypto symbols API error: ${res.status}`);
        const json = (await res.json()) as CryptoSymbolsResponse;
        setCryptoSymbols(json.items ?? []);
      } catch (e: any) {
        setCryptoSymbolsError(e?.message ?? "Failed to load crypto symbols");
        setCryptoSymbols([]);
      } finally {
        setCryptoSymbolsLoading(false);
      }
    })();

    loadNews("market", symbol);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filteredSymbols = useMemo(() => {
    const q = symbolQuery.trim().toLowerCase();

    if (assetType === "crypto") {
      const list = cryptoSymbols;
      if (!q) return list.slice(0, 25);
      const matches = list.filter((it) => {
        const pair = (it.pair ?? "").toLowerCase();
        const name = (it.name ?? "").toLowerCase();
        return pair.includes(q) || name.includes(q);
      });
      return matches.slice(0, 25);
    }

    if (!q) return symbols.slice(0, 25);

    const matches = symbols.filter((it) => {
      return (
        it.symbol.toLowerCase().includes(q) ||
        (it.symbol_alt ?? "").toLowerCase().includes(q) ||
        it.name.toLowerCase().includes(q)
      );
    });

    return matches.slice(0, 25);
  }, [assetType, symbols, cryptoSymbols, symbolQuery]);

  // When tab changes, reload news for the active tab
  useEffect(() => {
    loadNews(newsTab, symbol);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newsTab, assetType]);

  // Also reload ticker news when the symbol changes (only if the ticker tab is active)
  useEffect(() => {
    if (newsTab === "ticker") {
      loadNews("ticker", symbol);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol]);

  async function run() {
    const raw = symbol.trim().toUpperCase();
    const s = isCrypto() ? normalizeCryptoPair(raw) : raw;
    if (!s) return;

    // Refresh ticker immediately
    fetchLiveQuote(s);

    // Auto-check accuracy (daily cached) - stocks only
    runBacktest(false, s);

    setLoading(true);
    setError(null);

    const startedAt = Date.now();

    const stepsStock = [
      "Waking up the AI server…",
      "Downloading the latest market data…",
      "Analyzing past prices…",
      "Comparing against SPY & QQQ…",
      "Training the model (cached for speed)…",
      "Predicting the future outcome…",
      "Rendering chart & results…",
    ];

    const stepsCrypto = [
      "Waking up the AI server…",
      "Downloading the latest crypto candles…",
      "Analyzing volatility…",
      "Training the model (cached for speed)…",
      "Predicting the next move…",
      "Rendering chart & results…",
    ];

    const steps = assetType === "crypto" ? stepsCrypto : stepsStock;

    setLoadingMsg(steps[0]);
    let i = 0;
    const timer = setInterval(() => {
      i = (i + 1) % steps.length;
      setLoadingMsg(steps[i]);
    }, 1200);

    try {
      const [predRes, histRes, fcRes] = await Promise.all([
        fetch(predictUrl(), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            isCrypto() ? { pair: s, timeframe } : { symbol: s, timeframe }
          ),
        }),
        fetch(historyUrl(s, timeframe, 200)),
        fetch(forecastUrl(), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            isCrypto() ? { pair: s, timeframe } : { symbol: s, timeframe }
          ),
        }),
      ]);

      if (!predRes.ok) throw new Error(`Predict API error: ${predRes.status}`);
      if (!histRes.ok) throw new Error(`History API error: ${histRes.status}`);
      if (!fcRes.ok) throw new Error(`Forecast API error: ${fcRes.status}`);

      const predJson = (await predRes.json()) as PredictResponse;
      const histJson = (await histRes.json()) as HistoryResponse;
      const fcJson = (await fcRes.json()) as ForecastResponse;

      setPred(predJson);
      setHist(histJson);
      setForecast(fcJson);
    } catch (e: any) {
      setError(
        e?.message ??
          `Network error (is backend running on ${API_BASE}/health ?)`
      );
      setPred(null);
      setHist(null);
      setForecast(null);
      setBt(null);
    } finally {
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

  async function runBacktest(force = false, symRaw?: string) {
    const raw = (symRaw ?? symbol).trim().toUpperCase();
    const s = raw; // backtest is stock-only
    if (!s) return;

    if (assetType === "crypto") {
      setBt(null);
      setBtError(null);
      setBtLoading(false);
      return;
    }

    setBtLoading(true);
    setBtError(null);

    try {
      const url = backtestUrl(s, timeframe, force);
      if (!url) return;

      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) throw new Error(`Backtest API error: ${res.status}`);

      const json = (await res.json()) as BacktestResponse;
      setBt(json);
    } catch (e: any) {
      setBt(null);
      setBtError(e?.message ?? "Backtest failed");
    } finally {
      setBtLoading(false);
    }
  }

  async function fetchLiveQuote(symRaw?: string) {
    const raw = (symRaw ?? symbol).trim().toUpperCase();
    const s = isCrypto() ? normalizeCryptoPair(raw) : raw;
    if (!s) return;

    setLiveLoading(true);
    try {
      const res = await fetch(historyUrl(s, timeframe, 2), {
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`Live price error: ${res.status}`);

      const j = (await res.json()) as HistoryResponse;
      const cs = j?.candles ?? [];
      if (cs.length === 0) return;

      const last = cs[cs.length - 1];
      const prev = cs.length >= 2 ? cs[cs.length - 2] : null;

      const lastClose = Number(last.close);
      const prevClose = prev ? Number(prev.close) : lastClose;
      const pctCh = prevClose ? ((lastClose - prevClose) / prevClose) * 100 : 0;

      setLivePrice(lastClose);
      setLiveChangePct(pctCh);
      setLiveUpdatedAt(new Date().toLocaleTimeString());
    } catch {
      setLivePrice(null);
      setLiveChangePct(null);
      setLiveUpdatedAt(null);
    } finally {
      setLiveLoading(false);
    }
  }

  useEffect(() => {
    fetchLiveQuote();
    const id = window.setInterval(() => fetchLiveQuote(), 30_000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, timeframe, assetType]);

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

  function toneBadge(label: string, tone: "good" | "bad" | "neutral") {
    const cls =
      tone === "good"
        ? "border-emerald-700 bg-emerald-950/40 text-emerald-200"
        : tone === "bad"
        ? "border-red-700 bg-red-950/40 text-red-200"
        : "border-zinc-700 bg-zinc-950 text-zinc-200";

    return (
      <span className={`px-2 py-1 rounded-lg text-xs border ${cls}`}>
        {label}
      </span>
    );
  }

  function pctTone(p: number) {
    if (p > 0.15) return "good" as const;
    if (p < -0.15) return "bad" as const;
    return "neutral" as const;
  }

  function confidenceLabel(c: number) {
    const x = clamp01(c);
    if (x >= 0.75) return { label: "High", tone: "good" as const };
    if (x >= 0.5) return { label: "Medium", tone: "neutral" as const };
    return { label: "Low", tone: "bad" as const };
  }

  function expectedMovePct(
    rangeLow: number,
    rangeHigh: number,
    lastClose: number
  ) {
    const w = Math.max(0, rangeHigh - rangeLow);
    if (!lastClose || lastClose === 0) return 0;
    return (w / lastClose) * 100;
  }

  function riskLabelFromMove(movePct: number) {
    if (movePct >= 6) return { label: "High", tone: "bad" as const };
    if (movePct >= 3) return { label: "Medium", tone: "neutral" as const };
    return { label: "Low", tone: "good" as const };
  }

  function marketBias(market?: PredictResponse["market"]) {
    const spy = market?.SPY_ret_1 ?? 0;
    const qqq = market?.QQQ_ret_1 ?? 0;
    const avg = (spy + qqq) / 2;
    if (avg > 0.15)
      return { label: "Risk-on", detail: "SPY/QQQ up", tone: "good" as const };
    if (avg < -0.15)
      return { label: "Risk-off", detail: "SPY/QQQ down", tone: "bad" as const };
    return { label: "Mixed", detail: "SPY/QQQ flat", tone: "neutral" as const };
  }

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100">
      <div className="max-w-5xl mx-auto p-6">
        <header className="flex flex-col gap-2">
          <h1 className="text-3xl font-semibold tracking-tight">
            Market Predictor
          </h1>
          <p className="text-sm text-zinc-400 max-w-2xl">
            Forecasting demo using free market data + baseline ML. Stocks use
            market context (SPY/QQQ). Crypto runs without SPY/QQQ context. Not
            financial advice.
          </p>

          <div className="mt-2 flex flex-wrap gap-2 text-xs">
            <span className="px-2 py-1 rounded-lg border border-zinc-800 bg-zinc-950 text-zinc-300">
              Backend:{" "}
              {backendOk === null
                ? "checking…"
                : backendOk
                ? "online"
                : "offline"}
            </span>
            <span className="px-2 py-1 rounded-lg border border-zinc-800 bg-zinc-950 text-zinc-300">
              Asset: {assetType === "crypto" ? "crypto" : "stock"}
            </span>
            <span className="px-2 py-1 rounded-lg border border-zinc-800 bg-zinc-950 text-zinc-300">
              Data: {pred?.source ?? "—"}
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

          <div className="mt-3 flex flex-wrap items-center gap-2 rounded-2xl border border-zinc-800 bg-zinc-900/40 px-4 py-3">
            <span className="text-xs text-zinc-400">Live</span>
            <span className="px-2 py-1 rounded-lg border border-zinc-800 bg-zinc-950 text-xs text-zinc-200">
              {displaySymbol() || "—"}
            </span>

            {liveLoading && livePrice === null ? (
              <span className="text-sm text-zinc-500">Loading price…</span>
            ) : livePrice !== null ? (
              <>
                <span className="text-sm font-semibold">
                  ${fmtMoney(livePrice)}
                </span>
                {liveChangePct !== null && (
                  <span
                    className={
                      liveChangePct >= 0
                        ? "text-xs text-emerald-200"
                        : "text-xs text-red-200"
                    }
                  >
                    {liveChangePct >= 0 ? "+" : ""}
                    {liveChangePct.toFixed(2)}%
                  </span>
                )}
                <span className="text-xs text-zinc-500">
                  Updated {liveUpdatedAt ?? "—"}
                </span>
              </>
            ) : (
              <span className="text-sm text-zinc-500">Price unavailable</span>
            )}

            <button
              type="button"
              onClick={() => fetchLiveQuote()}
              className="ml-auto rounded-xl px-3 py-1.5 bg-zinc-100 text-zinc-900 text-xs font-medium hover:bg-white disabled:opacity-60"
              disabled={liveLoading}
              title="Refresh live price"
            >
              {liveLoading ? "Refreshing…" : "Refresh"}
            </button>
          </div>
        </header>

        <section className="mt-6 grid grid-cols-1 md:grid-cols-5 gap-4">
          <div className="md:col-span-3 rounded-2xl border border-zinc-800 bg-zinc-900/40 p-5">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex gap-3 w-full">
                {/* Asset Type toggle */}
                <div className="flex rounded-xl border border-zinc-800 bg-zinc-950 overflow-hidden">
                  <button
                    type="button"
                    onClick={() => {
                      setAssetType("stock");
                      const next = symbol.trim().toUpperCase();
                      const pick = next || "AAPL";
                      setSymbol(pick);
                      setSymbolQuery(pick);
                      setNewsTab("market");
                    }}
                    className={`px-3 py-3 text-xs font-medium transition ${
                      assetType === "stock"
                        ? "bg-zinc-100 text-zinc-900"
                        : "text-zinc-300 hover:bg-zinc-900/50"
                    }`}
                    aria-pressed={assetType === "stock"}
                  >
                    Stocks
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setAssetType("crypto");
                      const next = symbol.trim().toUpperCase();
                      const pick =
                        next && next.includes("-")
                          ? next
                          : normalizeCryptoPair(next || "BTC");
                      setSymbol(pick);
                      setSymbolQuery(pick);
                      setNewsTab("market");
                      setBt(null);
                    }}
                    className={`px-3 py-3 text-xs font-medium transition ${
                      assetType === "crypto"
                        ? "bg-zinc-100 text-zinc-900"
                        : "text-zinc-300 hover:bg-zinc-900/50"
                    }`}
                    aria-pressed={assetType === "crypto"}
                  >
                    Crypto
                  </button>
                </div>

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
                      setTimeout(() => setComboOpen(false), 150);
                      setSymbol(symbolQuery.trim().toUpperCase());
                    }}
                    placeholder={
                      assetType === "crypto"
                        ? cryptoSymbolsLoading
                          ? "Loading crypto…"
                          : "Search crypto (e.g., BTC-USD, ETH-USD)"
                        : symbolsLoading
                        ? "Loading S&P 500…"
                        : "Search S&P 500 (e.g., Apple or AAPL)"
                    }
                    aria-label="Search ticker"
                  />

                  {comboOpen && (
                    <div className="absolute z-20 mt-2 w-full rounded-xl border border-zinc-800 bg-zinc-950 shadow-lg overflow-hidden">
                      <div className="max-h-72 overflow-auto">
                        {assetType === "crypto" ? (
                          cryptoSymbolsError ? (
                            <div className="p-3 text-sm text-red-200">
                              {cryptoSymbolsError}
                            </div>
                          ) : cryptoSymbolsLoading ? (
                            <div className="p-3 text-sm text-zinc-400">
                              Loading crypto…
                            </div>
                          ) : filteredSymbols.length === 0 ? (
                            <div className="p-3 text-sm text-zinc-500">
                              No matches. You can still type BTC-USD, ETH-USD,
                              etc.
                            </div>
                          ) : (
                            filteredSymbols.map((it: any) => {
                              const displaySymbol = String(
                                it.pair ?? ""
                              ).toUpperCase();
                              const displayName = it.name
                                ? String(it.name)
                                : "Cryptocurrency";

                              return (
                                <button
                                  key={displaySymbol}
                                  type="button"
                                  onMouseDown={(e) => e.preventDefault()}
                                  onClick={() => {
                                    setSymbol(displaySymbol);
                                    setSymbolQuery(displaySymbol);
                                    setComboOpen(false);
                                  }}
                                  className="w-full text-left px-4 py-3 hover:bg-zinc-900/60 border-b border-zinc-900/50 last:border-b-0"
                                >
                                  <div className="flex items-center justify-between gap-3">
                                    <div className="min-w-0">
                                      <div className="text-sm font-semibold text-zinc-100 truncate">
                                        {displaySymbol}
                                        <span className="ml-2 text-xs font-normal text-zinc-400 truncate">
                                          {displayName}
                                        </span>
                                      </div>
                                    </div>
                                    <span className="text-xs text-zinc-400">
                                      Select
                                    </span>
                                  </div>
                                </button>
                              );
                            })
                          )
                        ) : symbolsError ? (
                          <div className="p-3 text-sm text-red-200">
                            {symbolsError}
                          </div>
                        ) : symbolsLoading ? (
                          <div className="p-3 text-sm text-zinc-400">
                            Loading symbols…
                          </div>
                        ) : filteredSymbols.length === 0 ? (
                          <div className="p-3 text-sm text-zinc-500">
                            No matches. You can still type a ticker manually.
                          </div>
                        ) : (
                          filteredSymbols.map((it: any) => {
                            const displaySymbol = String(
                              (it.symbol_alt ?? it.symbol) ?? ""
                            ).toUpperCase();
                            const displayName = String(it.name ?? "");
                            const displayMeta = it.sector
                              ? String(it.sector)
                              : null;

                            return (
                              <button
                                key={displaySymbol}
                                type="button"
                                onMouseDown={(e) => e.preventDefault()}
                                onClick={() => {
                                  setSymbol(displaySymbol);
                                  setSymbolQuery(displaySymbol);
                                  setComboOpen(false);
                                }}
                                className="w-full text-left px-4 py-3 hover:bg-zinc-900/60 border-b border-zinc-900/50 last:border-b-0"
                              >
                                <div className="flex items-center justify-between gap-3">
                                  <div className="min-w-0">
                                    <div className="text-sm font-semibold text-zinc-100 truncate">
                                      {displaySymbol}
                                      <span className="ml-2 text-xs font-normal text-zinc-400 truncate">
                                        {displayName}
                                      </span>
                                    </div>
                                    {displayMeta ? (
                                      <div className="mt-1 text-xs text-zinc-500 truncate">
                                        {displayMeta}
                                      </div>
                                    ) : null}
                                  </div>
                                  <span className="text-xs text-zinc-400">
                                    Select
                                  </span>
                                </div>
                              </button>
                            );
                          })
                        )}
                      </div>
                    </div>
                  )}

                  <div className="mt-1 text-[11px] text-zinc-500">
                    {assetType === "crypto"
                      ? cryptoSymbolsLoading
                        ? "Loading crypto…"
                        : cryptoSymbolsError
                        ? "Crypto symbols failed to load — you can still type BTC-USD, ETH-USD, etc."
                        : `Loaded ${cryptoSymbols.length} crypto symbols.`
                      : symbolsLoading
                      ? "Loading symbols…"
                      : symbolsError
                      ? "Symbols failed to load — you can still type any ticker manually."
                      : `Loaded ${symbols.length} S&P 500 symbols. Search by name or ticker.`}
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
                    <div className="mt-1 text-lg font-semibold">
                      ${fmtMoney(pred.last_close)}
                    </div>
                  </div>
                  <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-3">
                    <div className="text-xs text-zinc-500">Predicted next</div>
                    <div className="mt-1 text-lg font-semibold">
                      ${fmtMoney(pred.prediction)}
                    </div>
                  </div>
                  <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-3">
                    <div className="text-xs text-zinc-500">Change</div>
                    <div className="mt-1 text-lg font-semibold">
                      {changePct === null ? (
                        "—"
                      ) : (
                        <span
                          className={
                            changePct >= 0 ? "text-emerald-200" : "text-red-200"
                          }
                        >
                          {changePct >= 0 ? "+" : ""}
                          {changePct.toFixed(2)}%
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
            {assetType === "stock" ? (
              <div className="mt-4 flex flex-wrap gap-2 text-xs text-zinc-300">
                <span className="px-2 py-1 rounded-lg border border-zinc-800 bg-zinc-950">
                  Market context:
                </span>

                {pred?.market ? (
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
            ) : (
              <div className="mt-4 text-xs text-zinc-500">
                Crypto mode: no SPY/QQQ market context.
              </div>
            )}

            <div className="mt-4 h-[340px] min-w-0 w-full rounded-2xl border border-zinc-800 bg-zinc-950 p-3">
              {candles.length === 0 ? (
                <div className="h-full flex items-center justify-center text-sm text-zinc-500">
                  Run a prediction to load the candlestick chart (last 200
                  candles).
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

            <div className="mt-3 space-y-3">
              {/* Insights strip */}
              <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
                <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-3">
                  <div className="text-[11px] text-zinc-500">
                    Trend (last ~20)
                  </div>
                  <div className="mt-1 text-sm">
                    {insights.ok ? (
                      <span
                        className={
                          insights.trendTone === "good"
                            ? "text-emerald-200"
                            : insights.trendTone === "bad"
                            ? "text-red-200"
                            : "text-zinc-200"
                        }
                      >
                        {insights.trendLabel}
                      </span>
                    ) : (
                      <span className="text-zinc-500">—</span>
                    )}
                  </div>
                </div>

                <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-3">
                  <div className="text-[11px] text-zinc-500">
                    Volatility (avg move)
                  </div>
                  <div className="mt-1 text-sm text-zinc-200">
                    {insights.ok ? `~${insights.volPct.toFixed(2)}%` : "—"}
                  </div>
                </div>

                <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-3">
                  <div className="text-[11px] text-zinc-500">
                    High (last {insights.ok ? insights.lookback : "—"})
                  </div>
                  <div className="mt-1 text-sm text-zinc-200">
                    {insights.ok && insights.hi !== null
                      ? `$${fmtMoney(insights.hi)}`
                      : "—"}
                  </div>
                </div>

                <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-3">
                  <div className="text-[11px] text-zinc-500">
                    Low (last {insights.ok ? insights.lookback : "—"})
                  </div>
                  <div className="mt-1 text-sm text-zinc-200">
                    {insights.ok && insights.lo !== null
                      ? `$${fmtMoney(insights.lo)}`
                      : "—"}
                  </div>
                </div>

                <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-3">
                  <div className="text-[11px] text-zinc-500">Volume vs avg</div>
                  <div className="mt-1 text-sm">
                    {insights.ok &&
                    insights.volNow !== null &&
                    insights.volAvg !== null ? (
                      <span
                        className={
                          insights.volTone === "good"
                            ? "text-emerald-200"
                            : insights.volTone === "bad"
                            ? "text-red-200"
                            : "text-zinc-200"
                        }
                      >
                        {insights.volAvg
                          ? `${(insights.volNow / insights.volAvg).toFixed(2)}×`
                          : "—"}
                      </span>
                    ) : (
                      <span className="text-zinc-500">—</span>
                    )}
                  </div>
                </div>
              </div>

              {/* Meta line */}
              <div className="text-xs text-zinc-500">
                Source: {pred?.source ?? "—"} • Timeframe: {timeframe} • Last{" "}
                {candles.length || 0} candles
              </div>

              {/* ✅ NEW: fills the empty space under chart */}
              <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
                {/* Technical snapshot */}
                <div className="md:col-span-2 rounded-2xl border border-zinc-800 bg-zinc-950 p-4">
                  <div className="flex items-center justify-between">
                    <h3 className="text-xs font-medium text-zinc-300">
                      Technical snapshot
                    </h3>
                    <span className="text-[11px] text-zinc-500">
                      Last 20 candles
                    </span>
                  </div>

                  {!technicals.ok ? (
                    <div className="mt-3 text-sm text-zinc-500">
                      Run Predict to load indicators.
                    </div>
                  ) : (
                    <div className="mt-3 grid grid-cols-2 gap-2">
                      <div className="rounded-xl border border-zinc-800 bg-zinc-900/20 p-3">
                        <div className="text-[11px] text-zinc-500">
                          Last change
                        </div>
                        <div
                          className={
                            technicals.lastChangePct !== null &&
                            technicals.lastChangePct >= 0
                              ? "mt-1 text-sm font-semibold text-emerald-200"
                              : "mt-1 text-sm font-semibold text-red-200"
                          }
                        >
                          {technicals.lastChangePct === null
                            ? "—"
                            : `${technicals.lastChangePct >= 0 ? "+" : ""}${technicals.lastChangePct.toFixed(
                                2
                              )}%`}
                        </div>
                      </div>

                      <div className="rounded-xl border border-zinc-800 bg-zinc-900/20 p-3">
                        <div className="text-[11px] text-zinc-500">
                          Avg range
                        </div>
                        <div className="mt-1 text-sm font-semibold text-zinc-100">
                          {technicals.avgRangePct === null
                            ? "—"
                            : `~${technicals.avgRangePct.toFixed(2)}%`}
                        </div>
                      </div>

                      <div className="rounded-xl border border-zinc-800 bg-zinc-900/20 p-3">
                        <div className="text-[11px] text-zinc-500">SMA 20</div>
                        <div className="mt-1 text-sm font-semibold text-zinc-100">
                          {technicals.sma20 === null
                            ? "—"
                            : `$${fmtMoney(technicals.sma20)}`}
                        </div>
                        {technicals.sma20 !== null &&
                        technicals.lastClose !== null ? (
                          <div className="mt-1 text-[11px] text-zinc-500">
                            Price vs SMA20:{" "}
                            {pct(technicals.lastClose, technicals.sma20).toFixed(
                              2
                            )}
                            %
                          </div>
                        ) : null}
                      </div>

                      <div className="rounded-xl border border-zinc-800 bg-zinc-900/20 p-3">
                        <div className="text-[11px] text-zinc-500">SMA 50</div>
                        <div className="mt-1 text-sm font-semibold text-zinc-100">
                          {technicals.sma50 === null
                            ? "—"
                            : `$${fmtMoney(technicals.sma50)}`}
                        </div>
                        {technicals.sma50 !== null &&
                        technicals.lastClose !== null ? (
                          <div className="mt-1 text-[11px] text-zinc-500">
                            Price vs SMA50:{" "}
                            {pct(technicals.lastClose, technicals.sma50).toFixed(
                              2
                            )}
                            %
                          </div>
                        ) : null}
                      </div>

                      <div className="rounded-xl border border-zinc-800 bg-zinc-900/20 p-3">
                        <div className="text-[11px] text-zinc-500">RSI (14)</div>
                        <div className="mt-1 text-sm font-semibold text-zinc-100">
                          {technicals.rsi14 === null
                            ? "—"
                            : technicals.rsi14.toFixed(0)}
                        </div>
                        <div className="mt-1 text-[11px] text-zinc-500">
                          {technicals.rsi14 === null
                            ? ""
                            : technicals.rsi14 >= 70
                            ? "Overbought"
                            : technicals.rsi14 <= 30
                            ? "Oversold"
                            : "Neutral"}
                        </div>
                      </div>

                      <div className="rounded-xl border border-zinc-800 bg-zinc-900/20 p-3">
                        <div className="text-[11px] text-zinc-500">
                          Support / Resistance
                        </div>
                        <div className="mt-1 text-sm font-semibold text-zinc-100">
                          {technicals.support === null ||
                          technicals.resistance === null
                            ? "—"
                            : `$${fmtMoney(technicals.support)} / $${fmtMoney(
                                technicals.resistance
                              )}`}
                        </div>
                        <div className="mt-1 text-[11px] text-zinc-500">
                          Simple levels from last 20 candles
                        </div>
                      </div>
                    </div>
                  )}
                </div>

                {/* Recent candles */}
                <div className="md:col-span-3 rounded-2xl border border-zinc-800 bg-zinc-950 p-4">
                  <div className="flex items-center justify-between">
                    <h3 className="text-xs font-medium text-zinc-300">
                      Recent candles
                    </h3>
                    <span className="text-[11px] text-zinc-500">Last 10</span>
                  </div>

                  {candles.length === 0 ? (
                    <div className="mt-3 text-sm text-zinc-500">
                      Run Predict to load candles.
                    </div>
                  ) : (
                    <div className="mt-3 overflow-auto">
                      <table className="w-full text-left text-xs">
                        <thead className="text-zinc-500">
                          <tr className="border-b border-zinc-800">
                            <th className="py-2 pr-2 font-medium">Time</th>
                            <th className="py-2 pr-2 font-medium">Close</th>
                            <th className="py-2 pr-2 font-medium">Change</th>
                            <th className="py-2 pr-2 font-medium">Range</th>
                            <th className="py-2 font-medium">Volume</th>
                          </tr>
                        </thead>
                        <tbody>
                          {candles
                            .slice(-10)
                            .reverse()
                            .map((c, idx, arr) => {
                              const close = safeNum(c.close);
                              const prev = arr[idx + 1]
                                ? safeNum(arr[idx + 1].close)
                                : close;
                              const ch = prev
                                ? ((close - prev) / prev) * 100
                                : 0;
                              const rangeMid =
                                (safeNum(c.high) + safeNum(c.low)) / 2;
                              const rangePct = rangeMid
                                ? ((safeNum(c.high) - safeNum(c.low)) /
                                    rangeMid) *
                                  100
                                : 0;

                              return (
                                <tr
                                  key={`${c.time}-${idx}`}
                                  className="border-b border-zinc-900/60 last:border-b-0"
                                >
                                  <td className="py-2 pr-2 text-zinc-400 whitespace-nowrap">
                                    {c.time}
                                  </td>
                                  <td className="py-2 pr-2 text-zinc-100 whitespace-nowrap">
                                    ${fmtMoney(close)}
                                  </td>
                                  <td
                                    className={
                                      ch >= 0
                                        ? "py-2 pr-2 text-emerald-200 whitespace-nowrap"
                                        : "py-2 pr-2 text-red-200 whitespace-nowrap"
                                    }
                                  >
                                    {ch >= 0 ? "+" : ""}
                                    {ch.toFixed(2)}%
                                  </td>
                                  <td className="py-2 pr-2 text-zinc-300 whitespace-nowrap">
                                    ~{rangePct.toFixed(2)}%
                                  </td>
                                  <td className="py-2 text-zinc-300 whitespace-nowrap">
                                    {safeNum(c.volume, 0).toLocaleString()}
                                  </td>
                                </tr>
                              );
                            })}
                        </tbody>
                      </table>
                    </div>
                  )}

                  <div className="mt-3 text-[11px] text-zinc-500">
                    Tip: big range + volume spike often means a news-driven
                    candle.
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* RIGHT COLUMN: your Forecast panel stays the same (unchanged from your file) */}
          {/* NOTE: I’m not re-pasting the entire right column + News here again to keep this message readable. */}
          {/* If you want, paste your existing right column + News below this point exactly as-is. */}

          {/* ✅ IMPORTANT:
              If you want me to paste the *entire* remainder too, tell me:
              “paste the full rest too”
              and I’ll output the remaining unchanged blocks.
          */}
        </section>
      </div>
    </main>
  );
}
