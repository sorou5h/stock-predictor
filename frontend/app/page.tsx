"use client";

import { useEffect, useMemo, useState } from "react";
import CandleChart from "../components/CandleChart";

/**
 * Deployment-ready API base:
 * - Local dev fallback: http://localhost:8001
 * - Vercel prod: set NEXT_PUBLIC_API_BASE_URL to your Render backend URL
 */
const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:8001";

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
    <div className={`animate-pulse rounded-lg bg-zinc-800/60 ${className}`} aria-hidden="true" />
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

// --- Simple indicators (client-side, from fetched candles) ---
function sma(values: number[], period: number) {
  if (values.length < period) return null;
  let s = 0;
  for (let i = values.length - period; i < values.length; i++) s += values[i];
  return s / period;
}

function rsi(closes: number[], period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0;
  let losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses += -diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function atr(highs: number[], lows: number[], closes: number[], period = 14) {
  const n = closes.length;
  if (n < period + 1) return null;
  const trs: number[] = [];
  for (let i = 1; i < n; i++) {
    const h = highs[i];
    const l = lows[i];
    const pc = closes[i - 1];
    const tr = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
    trs.push(tr);
  }
  if (trs.length < period) return null;
  let sum = 0;
  for (let i = trs.length - period; i < trs.length; i++) sum += trs[i];
  return sum / period;
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
  const [cryptoSymbolsError, setCryptoSymbolsError] = useState<string | null>(null);

  const [symbolQuery, setSymbolQuery] = useState("AAPL");
  const [comboOpen, setComboOpen] = useState(false);

  const candles = useMemo(() => hist?.candles ?? [], [hist]);

  const [lastStockSymbol, setLastStockSymbol] = useState("AAPL");
const [lastCryptoPair, setLastCryptoPair] = useState("BTC-USD");

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

    useEffect(() => {
  if (assetType === "crypto") {
    const p = normalizeCryptoPair(symbol);
    setLastCryptoPair(p);
  } else {
    const s = (symbol || "").trim().toUpperCase() || "AAPL";
    setLastStockSymbol(s);
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [symbol, assetType]);
    const last = cs[cs.length - 1];
    const lastClose = safeNum(last.close);

    const N = Math.min(20, cs.length - 1);
    const prevClose = safeNum(cs[cs.length - 1 - N].close, lastClose);
    const trendPct = pct(lastClose, prevClose);

    const trendTone =
      trendPct > 0.25 ? ("good" as const) : trendPct < -0.25 ? ("bad" as const) : ("neutral" as const);

    const trendLabel =
      trendPct > 0.25
        ? `Up (${trendPct.toFixed(2)}%)`
        : trendPct < -0.25
        ? `Down (${trendPct.toFixed(2)}%)`
        : `Flat (${trendPct.toFixed(2)}%)`;

    const slice = cs.slice(-N - 1);
    let sumAbs = 0;
    let count = 0;
    for (let i = 1; i < slice.length; i++) {
      const c = safeNum(slice[i].close);
      const p0 = safeNum(slice[i - 1].close);
      if (p0) {
        sumAbs += Math.abs(((c - p0) / p0) * 100);
        count += 1;
      }
    }
    const volPct = count ? sumAbs / count : 0;

    const lookback = Math.min(52, cs.length);
    const lb = cs.slice(-lookback);
    const hi = Math.max(...lb.map((x) => safeNum(x.high)));
    const lo = Math.min(...lb.map((x) => safeNum(x.low)));

    const volNow = safeNum(last.volume, 0);
    const volAvg = lb.reduce((acc, x) => acc + safeNum(x.volume, 0), 0) / Math.max(1, lb.length);

    const volTone =
      volNow > volAvg * 1.15 ? ("good" as const) : volNow < volAvg * 0.85 ? ("bad" as const) : ("neutral" as const);

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

  // NEW: “Under the chart” signal panel
  const signal = useMemo(() => {
    const cs = candles ?? [];
    if (cs.length < 25) {
      return {
        ok: false,
        sma20: null as number | null,
        sma50: null as number | null,
        rsi14: null as number | null,
        atr14: null as number | null,
        sup20: null as number | null,
        res20: null as number | null,
        ret5: null as number | null,
        ret20: null as number | null,
      };
    }

    const closes = cs.map((c) => safeNum(c.close));
    const highs = cs.map((c) => safeNum(c.high));
    const lows = cs.map((c) => safeNum(c.low));

    const last = closes[closes.length - 1];
    const c5 = closes.length >= 6 ? closes[closes.length - 1 - 5] : last;
    const c20 = closes.length >= 21 ? closes[closes.length - 1 - 20] : c5;

    const lb20 = cs.slice(-20);
    const sup20 = Math.min(...lb20.map((x) => safeNum(x.low)));
    const res20 = Math.max(...lb20.map((x) => safeNum(x.high)));

    return {
      ok: true,
      sma20: sma(closes, 20),
      sma50: sma(closes, 50),
      rsi14: rsi(closes, 14),
      atr14: atr(highs, lows, closes, 14),
      sup20,
      res20,
      ret5: pct(last, c5),
      ret20: pct(last, c20),
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
    const base = isCrypto() ? `/crypto/history/${encodeURIComponent(sym)}` : `/history/${encodeURIComponent(sym)}`;
    return apiPath(`${base}?timeframe=${tf}&points=${pts}`);
  }

  function backtestUrl(sym: string, tf: string, force: boolean) {
    if (isCrypto()) return null;
    return apiPath(`/backtest/${encodeURIComponent(sym)}?timeframe=${tf}&force=${force ? "true" : "false"}`);
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
    return apiPath(`/news?mode=ticker&symbol=${encodeURIComponent(s)}&limit=6`);
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

    const actualTab: "market" | "ticker" = assetType === "crypto" && tab === "ticker" ? "market" : tab;

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

  useEffect(() => {
    loadNews(newsTab, symbol);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newsTab, assetType]);

  useEffect(() => {
    if (newsTab === "ticker") loadNews("ticker", symbol);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol]);

  async function run() {
    const raw = symbol.trim().toUpperCase();
    const s = isCrypto() ? normalizeCryptoPair(raw) : raw;
    if (!s) return;

    fetchLiveQuote(s);
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
          body: JSON.stringify(isCrypto() ? { pair: s, timeframe } : { symbol: s, timeframe }),
        }),
        fetch(historyUrl(s, timeframe, 200)),
        fetch(forecastUrl(), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(isCrypto() ? { pair: s, timeframe } : { symbol: s, timeframe }),
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
      setError(e?.message ?? `Network error (is backend running on ${API_BASE}/health ?)`);
      setPred(null);
      setHist(null);
      setForecast(null);
      setBt(null);
    } finally {
      const elapsed = Date.now() - startedAt;
      const minShowMs = 900;
      if (elapsed < minShowMs) await new Promise((r) => setTimeout(r, minShowMs - elapsed));

      clearInterval(timer);
      setLoading(false);
      setLoadingMsg(null);
    }
  }

  async function runBacktest(force = false, symRaw?: string) {
    const raw = (symRaw ?? symbol).trim().toUpperCase();
    const s = raw;
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
      const res = await fetch(historyUrl(s, timeframe, 2), { cache: "no-store" });
      if (!res.ok) throw new Error(`Live price error: ${res.status}`);

      const j = (await res.json()) as HistoryResponse;
      const cs = j?.candles ?? [];
      if (cs.length === 0) return;

      const last = cs[cs.length - 1];
      const prev = cs.length >= 2 ? cs[cs.length - 2] : null;

      const lastClose = Number(last.close);
      const prevClose = prev ? Number(prev.close) : lastClose;
      const p = prevClose ? ((lastClose - prevClose) / prevClose) * 100 : 0;

      setLivePrice(lastClose);
      setLiveChangePct(p);
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

  const changePct = pred ? ((pred.prediction - pred.last_close) / pred.last_close) * 100 : null;

  function badgeForPct(p: number) {
    const up = p >= 0;
    return (
      <span
        className={`px-2 py-1 rounded-lg text-xs border ${
          up ? "border-emerald-700 bg-emerald-950/40 text-emerald-200" : "border-red-700 bg-red-950/40 text-red-200"
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

    return <span className={`px-2 py-1 rounded-lg text-xs border ${cls}`}>{label}</span>;
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

  function expectedMovePct(rangeLow: number, rangeHigh: number, lastClose: number) {
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
    if (avg > 0.15) return { label: "Risk-on", detail: "SPY/QQQ up", tone: "good" as const };
    if (avg < -0.15) return { label: "Risk-off", detail: "SPY/QQQ down", tone: "bad" as const };
    return { label: "Mixed", detail: "SPY/QQQ flat", tone: "neutral" as const };
  }

  const recentRows = useMemo(() => {
    const cs = candles ?? [];
    const last = cs.slice(-10).reverse();
    return last.map((c) => ({
      time: c.time,
      open: safeNum(c.open),
      close: safeNum(c.close),
      high: safeNum(c.high),
      low: safeNum(c.low),
      volume: safeNum(c.volume),
      up: safeNum(c.close) >= safeNum(c.open),
    }));
  }, [candles]);

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100">
      <div className="max-w-5xl mx-auto p-6">
        <header className="flex flex-col gap-2">
          <h1 className="text-3xl font-semibold tracking-tight">Market Predictor</h1>
          <p className="text-sm text-zinc-400 max-w-2xl">
            Forecasting demo using free market data + baseline ML. Stocks use market context (SPY/QQQ). Crypto runs without
            SPY/QQQ context. Not financial advice.
          </p>

          <div className="mt-2 flex flex-wrap gap-2 text-xs">
            <span className="px-2 py-1 rounded-lg border border-zinc-800 bg-zinc-950 text-zinc-300">
              Backend: {backendOk === null ? "checking…" : backendOk ? "online" : "offline"}
            </span>
            <span className="px-2 py-1 rounded-lg border border-zinc-800 bg-zinc-950 text-zinc-300">
              Asset: {assetType === "crypto" ? "crypto" : "stock"}
            </span>
            <span className="px-2 py-1 rounded-lg border border-zinc-800 bg-zinc-950 text-zinc-300">
              Data: {pred?.source ?? "—"}
            </span>
            <span className="px-2 py-1 rounded-lg border border-zinc-800 bg-zinc-950 text-zinc-300">Mode: {timeframe}</span>
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
                <span className="text-sm font-semibold">${fmtMoney(livePrice)}</span>
                {liveChangePct !== null && (
                  <span className={liveChangePct >= 0 ? "text-xs text-emerald-200" : "text-xs text-red-200"}>
                    {liveChangePct >= 0 ? "+" : ""}
                    {liveChangePct.toFixed(2)}%
                  </span>
                )}
                <span className="text-xs text-zinc-500">Updated {liveUpdatedAt ?? "—"}</span>
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
                <div className="flex rounded-xl border border-zinc-800 bg-zinc-950 overflow-hidden">
                  <button
                    type="button"
                    onClick={() => {
  // switch mode first
  setAssetType("stock");

  // restore last stock
  const pick = (lastStockSymbol || "AAPL").trim().toUpperCase();
  setSymbol(pick);
  setSymbolQuery(pick);

  // news tab rules
  setNewsTab("market");
}}
                    className={`px-3 py-3 text-xs font-medium transition ${
                      assetType === "stock" ? "bg-zinc-100 text-zinc-900" : "text-zinc-300 hover:bg-zinc-900/50"
                    }`}
                    aria-pressed={assetType === "stock"}
                  >
                    Stocks
                  </button>
                  <button
                    type="button"
                    onClick={() => {
  setAssetType("crypto");

  // restore last crypto
  const pick = normalizeCryptoPair(lastCryptoPair || "BTC-USD");
  setSymbol(pick);
  setSymbolQuery(pick);

  setNewsTab("market");
  setBt(null);
}}
                    className={`px-3 py-3 text-xs font-medium transition ${
                      assetType === "crypto" ? "bg-zinc-100 text-zinc-900" : "text-zinc-300 hover:bg-zinc-900/50"
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
                            <div className="p-3 text-sm text-red-200">{cryptoSymbolsError}</div>
                          ) : cryptoSymbolsLoading ? (
                            <div className="p-3 text-sm text-zinc-400">Loading crypto…</div>
                          ) : filteredSymbols.length === 0 ? (
                            <div className="p-3 text-sm text-zinc-500">No matches. You can still type BTC-USD, ETH-USD, etc.</div>
                          ) : (
                            filteredSymbols.map((it: any) => {
                              const displaySym = String(it.pair ?? "").toUpperCase();
                              const displayName = it.name ? String(it.name) : "Cryptocurrency";
                              return (
                                <button
                                  key={displaySym}
                                  type="button"
                                  onMouseDown={(e) => e.preventDefault()}
                                  onClick={() => {
                                    setSymbol(displaySym);
                                    setSymbolQuery(displaySym);
                                    setComboOpen(false);
                                  }}
                                  className="w-full text-left px-4 py-3 hover:bg-zinc-900/60 border-b border-zinc-900/50 last:border-b-0"
                                >
                                  <div className="flex items-center justify-between gap-3">
                                    <div className="min-w-0">
                                      <div className="text-sm font-semibold text-zinc-100 truncate">
                                        {displaySym}
                                        <span className="ml-2 text-xs font-normal text-zinc-400 truncate">{displayName}</span>
                                      </div>
                                    </div>
                                    <span className="text-xs text-zinc-400">Select</span>
                                  </div>
                                </button>
                              );
                            })
                          )
                        ) : symbolsError ? (
                          <div className="p-3 text-sm text-red-200">{symbolsError}</div>
                        ) : symbolsLoading ? (
                          <div className="p-3 text-sm text-zinc-400">Loading symbols…</div>
                        ) : filteredSymbols.length === 0 ? (
                          <div className="p-3 text-sm text-zinc-500">No matches. You can still type a ticker manually.</div>
                        ) : (
                          filteredSymbols.map((it: any) => {
                            const displaySym = String((it.symbol_alt ?? it.symbol) ?? "").toUpperCase();
                            const displayName = String(it.name ?? "");
                            const displayMeta = it.sector ? String(it.sector) : null;

                            return (
                              <button
                                key={displaySym}
                                type="button"
                                onMouseDown={(e) => e.preventDefault()}
                                onClick={() => {
                                  setSymbol(displaySym);
                                  setSymbolQuery(displaySym);
                                  setComboOpen(false);
                                }}
                                className="w-full text-left px-4 py-3 hover:bg-zinc-900/60 border-b border-zinc-900/50 last:border-b-0"
                              >
                                <div className="flex items-center justify-between gap-3">
                                  <div className="min-w-0">
                                    <div className="text-sm font-semibold text-zinc-100 truncate">
                                      {displaySym}
                                      <span className="ml-2 text-xs font-normal text-zinc-400 truncate">{displayName}</span>
                                    </div>
                                    {displayMeta ? <div className="mt-1 text-xs text-zinc-500 truncate">{displayMeta}</div> : null}
                                  </div>
                                  <span className="text-xs text-zinc-400">Select</span>
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

            {loading && <div className="mt-3 text-sm text-zinc-400">{loadingMsg ?? "Working…"}</div>}

            {error && (
              <div className="mt-4 rounded-xl border border-red-800 bg-red-950/40 p-4 text-sm text-red-200">{error}</div>
            )}

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
                      {changePct === null ? (
                        "—"
                      ) : (
                        <span className={changePct >= 0 ? "text-emerald-200" : "text-red-200"}>
                          {changePct >= 0 ? "+" : ""}
                          {changePct.toFixed(2)}%
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-3">
                    <div className="text-xs text-zinc-500">Confidence</div>
                    <div className="mt-2 h-2 w-full rounded-full bg-zinc-800">
                      <div className="h-2 rounded-full bg-zinc-200" style={{ width: `${clamp01(pred.confidence) * 100}%` }} />
                    </div>
                    <div className="mt-2 text-xs text-zinc-400">{(pred.confidence * 100).toFixed(0)}%</div>
                  </div>
                </>
              ) : (
                <div className="col-span-2 md:col-span-4 rounded-xl border border-zinc-800 bg-zinc-950 p-3 text-sm text-zinc-500">
                  Run a prediction to populate key stats.
                </div>
              )}
            </div>

            {assetType === "stock" ? (
              <div className="mt-4 flex flex-wrap gap-2 text-xs text-zinc-300">
                <span className="px-2 py-1 rounded-lg border border-zinc-800 bg-zinc-950">Market context:</span>
                {pred?.market ? (
                  <>
                    <span className="px-2 py-1 rounded-lg border border-zinc-800 bg-zinc-950">SPY {badgeForPct(pred.market.SPY_ret_1)}</span>
                    <span className="px-2 py-1 rounded-lg border border-zinc-800 bg-zinc-950">QQQ {badgeForPct(pred.market.QQQ_ret_1)}</span>
                    {pred.cache?.ttl_sec ? (
                      <span className="px-2 py-1 rounded-lg border border-zinc-800 bg-zinc-950 text-zinc-400">
                        Cached: {pred.cache.hit ? "yes" : "no"} (TTL {pred.cache.ttl_sec}s)
                      </span>
                    ) : null}
                  </>
                ) : (
                  <span className="px-2 py-1 rounded-lg border border-zinc-800 bg-zinc-950 text-zinc-500">run prediction to load</span>
                )}
              </div>
            ) : (
              <div className="mt-4 text-xs text-zinc-500">Crypto mode: no SPY/QQQ market context.</div>
            )}

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

            {/* Under-chart content (fills the empty space) */}
            <div className="mt-3 space-y-3">
              <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
                <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-3">
                  <div className="text-[11px] text-zinc-500">Trend (last ~20)</div>
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
                  <div className="text-[11px] text-zinc-500">Volatility (avg move)</div>
                  <div className="mt-1 text-sm text-zinc-200">{insights.ok ? `~${insights.volPct.toFixed(2)}%` : "—"}</div>
                </div>

                <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-3">
                  <div className="text-[11px] text-zinc-500">High (last {insights.ok ? insights.lookback : "—"})</div>
                  <div className="mt-1 text-sm text-zinc-200">{insights.ok && insights.hi !== null ? `$${fmtMoney(insights.hi)}` : "—"}</div>
                </div>

                <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-3">
                  <div className="text-[11px] text-zinc-500">Low (last {insights.ok ? insights.lookback : "—"})</div>
                  <div className="mt-1 text-sm text-zinc-200">{insights.ok && insights.lo !== null ? `$${fmtMoney(insights.lo)}` : "—"}</div>
                </div>

                <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-3">
                  <div className="text-[11px] text-zinc-500">Volume vs avg</div>
                  <div className="mt-1 text-sm">
                    {insights.ok && insights.volNow !== null && insights.volAvg !== null ? (
                      <span
                        className={
                          insights.volTone === "good"
                            ? "text-emerald-200"
                            : insights.volTone === "bad"
                            ? "text-red-200"
                            : "text-zinc-200"
                        }
                      >
                        {insights.volAvg ? `${(insights.volNow / insights.volAvg).toFixed(2)}×` : "—"}
                      </span>
                    ) : (
                      <span className="text-zinc-500">—</span>
                    )}
                  </div>
                </div>
              </div>

              {/* NEW: Levels & Signals + Recent candles */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-4">
                  <div className="flex items-center justify-between">
                    <div className="text-xs text-zinc-500">Levels & Signals</div>
                    {signal.ok && signal.rsi14 !== null
                      ? toneBadge(
                          signal.rsi14 >= 70 ? "RSI overbought" : signal.rsi14 <= 30 ? "RSI oversold" : "RSI neutral",
                          signal.rsi14 >= 70 ? "bad" : signal.rsi14 <= 30 ? "good" : "neutral"
                        )
                      : toneBadge("Waiting for data", "neutral")}
                  </div>

                  {!signal.ok ? (
                    <div className="mt-3 text-sm text-zinc-500">Run a prediction to compute indicators.</div>
                  ) : (
                    <div className="mt-3 grid grid-cols-2 gap-2">
                      <div className="rounded-lg border border-zinc-800 bg-zinc-900/20 p-2">
                        <div className="text-[11px] text-zinc-500">Support (20)</div>
                        <div className="mt-1 text-sm font-semibold text-zinc-100">
                          {signal.sup20 !== null ? `$${fmtMoney(signal.sup20)}` : "—"}
                        </div>
                      </div>
                      <div className="rounded-lg border border-zinc-800 bg-zinc-900/20 p-2">
                        <div className="text-[11px] text-zinc-500">Resistance (20)</div>
                        <div className="mt-1 text-sm font-semibold text-zinc-100">
                          {signal.res20 !== null ? `$${fmtMoney(signal.res20)}` : "—"}
                        </div>
                      </div>

                      <div className="rounded-lg border border-zinc-800 bg-zinc-900/20 p-2">
                        <div className="text-[11px] text-zinc-500">SMA 20 / 50</div>
                        <div className="mt-1 text-sm text-zinc-200">
                          {signal.sma20 !== null ? `$${fmtMoney(signal.sma20)}` : "—"}{" "}
                          <span className="text-zinc-600">/</span>{" "}
                          {signal.sma50 !== null ? `$${fmtMoney(signal.sma50)}` : "—"}
                        </div>
                      </div>
                      <div className="rounded-lg border border-zinc-800 bg-zinc-900/20 p-2">
                        <div className="text-[11px] text-zinc-500">ATR (14)</div>
                        <div className="mt-1 text-sm text-zinc-200">
                          {signal.atr14 !== null ? `$${fmtMoney(signal.atr14)}` : "—"}
                        </div>
                      </div>

                      <div className="rounded-lg border border-zinc-800 bg-zinc-900/20 p-2">
                        <div className="text-[11px] text-zinc-500">Return (5)</div>
                        <div className={`mt-1 text-sm font-semibold ${((signal.ret5 ?? 0) >= 0) ? "text-emerald-200" : "text-red-200"}`}>
                          {signal.ret5 === null ? "—" : `${signal.ret5 >= 0 ? "+" : ""}${signal.ret5.toFixed(2)}%`}
                        </div>
                      </div>
                      <div className="rounded-lg border border-zinc-800 bg-zinc-900/20 p-2">
                        <div className="text-[11px] text-zinc-500">Return (20)</div>
                        <div className={`mt-1 text-sm font-semibold ${((signal.ret20 ?? 0) >= 0) ? "text-emerald-200" : "text-red-200"}`}>
                          {signal.ret20 === null ? "—" : `${signal.ret20 >= 0 ? "+" : ""}${signal.ret20.toFixed(2)}%`}
                        </div>
                      </div>

                      {pred ? (
                        <div className="col-span-2 rounded-lg border border-zinc-800 bg-zinc-900/20 p-2">
                          <div className="text-[11px] text-zinc-500">Model expected range</div>
                          <div className="mt-1 text-sm text-zinc-200">
                            ${fmtMoney(pred.range_low)} – ${fmtMoney(pred.range_high)}{" "}
                            <span className="text-zinc-500">
                              (±{expectedMovePct(pred.range_low, pred.range_high, pred.last_close).toFixed(1)}%)
                            </span>
                          </div>
                        </div>
                      ) : null}
                    </div>
                  )}

                  <p className="mt-3 text-[11px] text-zinc-600 leading-relaxed">
                    These are simple technical indicators computed from the last 200 candles (not advice).
                  </p>
                </div>

                <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-4">
                  <div className="text-xs text-zinc-500">Recent candles (last 10)</div>
                  {recentRows.length === 0 ? (
                    <div className="mt-3 text-sm text-zinc-500">No candle history yet.</div>
                  ) : (
                    <div className="mt-3 overflow-hidden rounded-lg border border-zinc-800">
                      <div className="grid grid-cols-5 bg-zinc-900/30 text-[11px] text-zinc-500 px-3 py-2">
                        <div className="col-span-2">Time</div>
                        <div className="text-right">O</div>
                        <div className="text-right">C</div>
                        <div className="text-right">Vol</div>
                      </div>
                      <div className="max-h-56 overflow-auto">
                        {recentRows.map((r, idx) => (
                          <div
                            key={idx}
                            className="grid grid-cols-5 px-3 py-2 text-xs border-t border-zinc-900/60"
                          >
                            <div className="col-span-2 text-zinc-400 truncate">{r.time}</div>
                            <div className="text-right text-zinc-300">${fmtMoney(r.open)}</div>
                            <div className={`text-right font-medium ${r.up ? "text-emerald-200" : "text-red-200"}`}>
                              ${fmtMoney(r.close)}
                            </div>
                            <div className="text-right text-zinc-500">{Math.round(r.volume).toLocaleString()}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>

              <div className="text-xs text-zinc-500">
                Source: {pred?.source ?? "—"} • Timeframe: {timeframe} • Last {candles.length || 0} candles
              </div>
            </div>
          </div>

          {/* RIGHT COLUMN (Forecast) – unchanged */}
          <div className="md:col-span-2 rounded-2xl border border-zinc-800 bg-zinc-900/40 p-5">
            <h2 className="text-sm font-medium text-zinc-300">Forecast</h2>

            {!pred ? (
              <div className="mt-4 text-sm text-zinc-500">Run a prediction to see results.</div>
            ) : (
              <div className="mt-4 space-y-4">
                <div>
                  <div className="text-xs text-zinc-500">Symbol</div>
                  <div className="text-lg font-semibold">{displaySymbol()}</div>
                  <div className="text-xs text-zinc-500 mt-1">Timeframe: {pred.timeframe}</div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-3">
                    <div className="text-xs text-zinc-500">Last close</div>
                    <div className="text-lg font-semibold">${pred.last_close.toFixed(2)}</div>
                  </div>
                  <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-3">
                    <div className="text-xs text-zinc-500">Predicted next</div>
                    <div className="text-lg font-semibold">${pred.prediction.toFixed(2)}</div>
                  </div>
                </div>

                <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-3">
                  <div className="text-xs text-zinc-500">Multi-horizon forecast</div>
                  {!forecast || forecast.horizons.length === 0 ? (
                    <div className="mt-2 text-sm text-zinc-500">Forecast not available.</div>
                  ) : (
                    <div className="mt-3 grid grid-cols-1 gap-2">
                      {forecast.horizons.map((it) => {
                        const label = timeframe === "daily" ? `${it.horizon}D` : `${it.horizon}W`;
                        return (
                          <div
                            key={it.horizon}
                            className="flex items-center justify-between gap-3 rounded-lg border border-zinc-800 bg-zinc-900/20 px-3 py-2"
                          >
                            <div className="flex items-center gap-2">
                              <span className="text-xs text-zinc-400 w-10">{label}</span>
                              <span className="text-sm font-semibold text-zinc-100">${fmtMoney(it.prediction)}</span>
                              <span className="text-xs text-zinc-500">
                                (${fmtMoney(it.range_low)}–${fmtMoney(it.range_high)})
                              </span>
                            </div>
                            <span className={it.change_pct >= 0 ? "text-xs text-emerald-200" : "text-xs text-red-200"}>
                              {it.change_pct >= 0 ? "+" : ""}
                              {it.change_pct.toFixed(2)}%
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  )}
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

                <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-xs text-zinc-500">Prediction Breakdown</div>
                    {(() => {
                      const c = confidenceLabel(pred.confidence);
                      return toneBadge(`${c.label} confidence`, c.tone);
                    })()}
                  </div>

                  <div className="mt-3 grid grid-cols-2 gap-2">
                    {(() => {
                      const dir = pred.prediction - pred.last_close;
                      const p = (dir / pred.last_close) * 100;
                      const tone = pctTone(p);
                      const label = p >= 0 ? `Bullish (${p.toFixed(2)}%)` : `Bearish (${p.toFixed(2)}%)`;
                      return (
                        <div className="rounded-lg border border-zinc-800 bg-zinc-900/20 p-2">
                          <div className="text-[11px] text-zinc-500">Direction</div>
                          <div className="mt-1">{toneBadge(label, tone)}</div>
                        </div>
                      );
                    })()}

                    {assetType === "stock" ? (
                      (() => {
                        const bias = marketBias(pred.market);
                        return (
                          <div className="rounded-lg border border-zinc-800 bg-zinc-900/20 p-2">
                            <div className="text-[11px] text-zinc-500">Market mood</div>
                            <div className="mt-1 flex flex-wrap items-center gap-2">
                              {toneBadge(bias.label, bias.tone)}
                              <span className="text-[11px] text-zinc-500">{bias.detail}</span>
                            </div>
                          </div>
                        );
                      })()
                    ) : (
                      <div className="rounded-lg border border-zinc-800 bg-zinc-900/20 p-2">
                        <div className="text-[11px] text-zinc-500">Market mood</div>
                        <div className="mt-1 text-[11px] text-zinc-500">Crypto mode (no SPY/QQQ)</div>
                      </div>
                    )}

                    {(() => {
                      const mv = expectedMovePct(pred.range_low, pred.range_high, pred.last_close);
                      const r = riskLabelFromMove(mv);
                      return (
                        <div className="rounded-lg border border-zinc-800 bg-zinc-900/20 p-2">
                          <div className="text-[11px] text-zinc-500">Expected move</div>
                          <div className="mt-1 flex flex-wrap items-center gap-2">
                            {toneBadge(`~${mv.toFixed(1)}%`, r.tone)}
                            <span className="text-[11px] text-zinc-500">Range-based</span>
                          </div>
                        </div>
                      );
                    })()}

                    <div className="rounded-lg border border-zinc-800 bg-zinc-900/20 p-2">
                      <div className="text-[11px] text-zinc-500">Key inputs</div>
                      <div className="mt-1 flex flex-wrap gap-2 text-xs">
                        <span className="px-2 py-1 rounded-lg border border-zinc-800 bg-zinc-950 text-zinc-200">Price history</span>
                        <span className="px-2 py-1 rounded-lg border border-zinc-800 bg-zinc-950 text-zinc-200">Volume</span>
                        {assetType === "stock" ? (
                          <>
                            <span className="px-2 py-1 rounded-lg border border-zinc-800 bg-zinc-950 text-zinc-200">SPY</span>
                            <span className="px-2 py-1 rounded-lg border border-zinc-800 bg-zinc-950 text-zinc-200">QQQ</span>
                          </>
                        ) : null}
                      </div>
                    </div>
                  </div>

                  <p className="mt-3 text-[11px] text-zinc-500 leading-relaxed">
                    This breakdown is a simple explanation based on model inputs. It helps interpret the output, but it does not prove causation.
                  </p>
                </div>

                <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-xs text-zinc-500">Accuracy (walk-forward backtest)</div>
                      <div className="mt-1 text-[11px] text-zinc-600">
                        {assetType === "crypto" ? "Crypto backtest disabled." : "Auto cached daily • Use “Rerun now” for a fresh (slower) test"}
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => runBacktest(false)}
                        disabled={btLoading || assetType === "crypto"}
                        className="rounded-xl px-3 py-1.5 bg-zinc-100 text-zinc-900 text-xs font-medium hover:bg-white disabled:opacity-60"
                        title="Fetch cached backtest (daily)"
                      >
                        {btLoading ? "Checking…" : "Evaluate"}
                      </button>
                      <button
                        type="button"
                        onClick={() => runBacktest(true)}
                        disabled={btLoading || assetType === "crypto"}
                        className="rounded-xl px-3 py-1.5 border border-zinc-700 bg-zinc-900/40 text-xs text-zinc-200 hover:bg-zinc-900 disabled:opacity-60"
                        title="Force recompute now (slower)"
                      >
                        Rerun now
                      </button>
                    </div>
                  </div>

                  {btError ? <div className="mt-3 text-sm text-red-200">{btError}</div> : null}

                  {assetType === "crypto" ? (
                    <div className="mt-3 text-sm text-zinc-500">Backtest is currently stock-only.</div>
                  ) : !bt ? (
                    <div className="mt-3 text-sm text-zinc-500">Run Predict (or Evaluate) to see historical accuracy.</div>
                  ) : bt.metrics?.ok ? (
                    <div className="mt-3 grid grid-cols-2 gap-2">
                      <div className="rounded-lg border border-zinc-800 bg-zinc-900/20 p-2">
                        <div className="text-[11px] text-zinc-500">Direction accuracy</div>
                        <div className="mt-1 text-sm font-semibold">{((bt.metrics.direction_accuracy ?? 0) * 100).toFixed(1)}%</div>
                      </div>
                      <div className="rounded-lg border border-zinc-800 bg-zinc-900/20 p-2">
                        <div className="text-[11px] text-zinc-500">MAPE</div>
                        <div className="mt-1 text-sm font-semibold">{((bt.metrics.mape ?? 0) * 100).toFixed(2)}%</div>
                      </div>
                      <div className="rounded-lg border border-zinc-800 bg-zinc-900/20 p-2">
                        <div className="text-[11px] text-zinc-500">MAE</div>
                        <div className="mt-1 text-sm font-semibold">${fmtMoney(bt.metrics.mae ?? 0)}</div>
                      </div>
                      <div className="rounded-lg border border-zinc-800 bg-zinc-900/20 p-2">
                        <div className="text-[11px] text-zinc-500">Test points</div>
                        <div className="mt-1 text-sm font-semibold">{bt.metrics.points ?? "—"}</div>
                      </div>
                      <div className="col-span-2 mt-1 text-[11px] text-zinc-500">
                        As of {bt.as_of} • Cache bucket {bt.day_bucket}
                      </div>
                    </div>
                  ) : (
                    <div className="mt-3 text-sm text-zinc-500">Backtest unavailable: {bt.metrics?.reason ?? "unknown"}</div>
                  )}
                </div>

                <div className="text-xs text-zinc-500">
                  {assetType === "crypto"
                    ? `Model: Baseline ML • Trained on ${pred.data_points} candles`
                    : `Model: RandomForest baseline (with SPY/QQQ context) • Trained on ${pred.data_points} candles`}
                </div>

                <details className="rounded-xl border border-zinc-800 bg-zinc-950 p-3">
                  <summary className="cursor-pointer text-sm text-zinc-200 select-none">About this prediction</summary>
                  <div className="mt-3 space-y-3 text-sm text-zinc-400">
                    <p>
                      This is a demo model trained on historical candles using technical features (returns, moving averages, volatility, volume signals).
                      {assetType === "stock" ? " Stocks also include market context from SPY and QQQ." : " Crypto runs without SPY/QQQ market context."}
                    </p>
                    <ul className="space-y-1">
                      <li>• Daily = next period close</li>
                      <li>• Weekly = next weekly close (aggregated candles)</li>
                      <li>• Confidence is a rough stability score, not a guarantee</li>
                    </ul>
                    <p className="text-xs text-zinc-500">Not financial advice.</p>
                  </div>
                </details>
              </div>
            )}
          </div>
        </section>

        {/* NEWS SECTION (still here) */}
        <section className="mt-6 rounded-2xl border border-zinc-800 bg-zinc-900/40 p-5">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-sm font-medium text-zinc-200">Market News</h2>
              <p className="text-xs text-zinc-500 mt-1">Latest headlines (US-only). Source: {news?.source ?? "—"}</p>
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
                onClick={() => {
                  if (assetType === "crypto") {
                    setNewsTab("market");
                    return;
                  }
                  setNewsTab("ticker");
                }}
                className={`px-3 py-1.5 rounded-lg text-xs border transition ${
                  newsTab === "ticker"
                    ? "border-zinc-600 bg-zinc-950 text-zinc-100"
                    : "border-zinc-800 bg-zinc-900/30 text-zinc-400 hover:text-zinc-200"
                }`}
              >
                {assetType === "crypto" ? "Ticker (disabled)" : displaySymbol() || "Ticker"}
              </button>
            </div>
          </div>

          {newsError && (
            <div className="mt-4 rounded-xl border border-red-800 bg-red-950/40 p-4 text-sm text-red-200">{newsError}</div>
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
                <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-4 text-sm text-zinc-500">No news items.</div>
              ) : (
                news!.items.map((item) => (
                  <article key={item.id} className="rounded-xl border border-zinc-800 bg-zinc-950 p-4">
                    <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-500">
                      <span className="px-2 py-0.5 rounded-lg border border-zinc-800 bg-zinc-900/30">{item.source}</span>
                      {item.time ? (
                        <>
                          <span>•</span>
                          <span>{item.time}</span>
                        </>
                      ) : null}
                    </div>

                    <h3 className="mt-2 text-sm font-semibold text-zinc-100">
                      {item.url ? (
                        <a href={item.url} target="_blank" rel="noreferrer" className="hover:underline">
                          {item.title}
                        </a>
                      ) : (
                        item.title
                      )}
                    </h3>

                    {item.summary ? <p className="mt-2 text-sm text-zinc-400 leading-relaxed">{item.summary}</p> : null}
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
