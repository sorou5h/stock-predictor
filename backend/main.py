from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Any
import pandas as pd
import numpy as np
import requests
from io import StringIO
from sklearn.ensemble import RandomForestRegressor
import time

# News endpoint imports
import os
import hashlib
from datetime import datetime


app = FastAPI(title="Stock Predictor API")

# Dev CORS: allow local frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],   # allow ALL origins (safe for now)
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ----------------------------
# Simple in-memory cache (MVP)
# ----------------------------
PRED_CACHE_TTL_SEC = 15 * 60  # 15 minutes
HIST_CACHE_TTL_SEC = 15 * 60
_pred_cache: dict[str, tuple[float, dict]] = {}
_hist_cache: dict[str, tuple[float, dict]] = {}

# Data cache: avoid re-downloading the same CSV repeatedly
DATA_CACHE_TTL_SEC = 15 * 60  # 15 minutes
_data_cache: dict[str, tuple[float, pd.DataFrame]] = {}

# Model cache: avoid retraining if the latest candle hasn't changed
MODEL_CACHE_TTL_SEC = 60 * 60  # 1 hour
_model_cache: dict[str, tuple[float, Any]] = {}
# stored value: {"model": fitted_model, "last_date": "YYYY-MM-DD", "feature_cols": [...]} 

# Tune cache: avoid re-running backtests constantly
TUNE_CACHE_TTL_SEC = 6 * 60 * 60  # 6 hours
_tune_cache: dict[str, tuple[float, Any]] = {}

# News cache
NEWS_CACHE_TTL_SEC = 10 * 60  # 10 minutes
_news_cache: dict[str, tuple[float, dict]] = {}

# Symbols cache (S&P 500 list)
SYMBOLS_CACHE_TTL_SEC = 24 * 60 * 60  # 24 hours
_symbols_cache: dict[str, tuple[float, dict]] = {}


class PredictRequest(BaseModel):
    symbol: str
    timeframe: str = "daily"  # "daily" or "weekly"


def normalize_timeframe(tf: str) -> str:
    tf = (tf or "").strip().lower()
    if tf not in ("daily", "weekly"):
        raise HTTPException(status_code=400, detail="timeframe must be daily or weekly")
    return tf


def fetch_stooq_ohlcv(symbol: str) -> pd.DataFrame:
    """
    Fetch DAILY OHLCV data from Stooq (free, no API key).
    Returns columns: Date, Open, High, Low, Close, Volume
    """
    # Cache by symbol for a short time so repeat requests are fast
    cache_key = f"stooq:{symbol.lower().strip()}:daily"
    cached = cache_get(_data_cache, cache_key, DATA_CACHE_TTL_SEC)
    if cached is not None:
        # return a copy so callers can safely modify
        return cached.copy()

    s = symbol.lower().strip()
    url = f"https://stooq.com/q/d/l/?s={s}.us&i=d"

    r = requests.get(url, timeout=20)
    if r.status_code != 200 or len(r.text) < 50:
        raise HTTPException(status_code=404, detail=f"Could not download data for {symbol}")

    df = pd.read_csv(StringIO(r.text))
    if "Date" not in df.columns or "Close" not in df.columns:
        raise HTTPException(status_code=400, detail="Unexpected data format from data provider")

    df["Date"] = pd.to_datetime(df["Date"])
    df = (
        df.sort_values("Date")
          .dropna(subset=["Open", "High", "Low", "Close", "Volume"])
          .reset_index(drop=True)
    )
    cache_set(_data_cache, cache_key, df)
    return df


def to_weekly(df: pd.DataFrame) -> pd.DataFrame:
    """
    Convert DAILY OHLCV data into WEEKLY candles.
    """
    weekly = (
        df.set_index("Date")
          .resample("W-FRI")
          .agg({
              "Open": "first",
              "High": "max",
              "Low": "min",
              "Close": "last",
              "Volume": "sum",
          })
          .dropna()
          .reset_index()
    )
    return weekly


def get_symbol_df(symbol: str, tf: str) -> pd.DataFrame:
    df = fetch_stooq_ohlcv(symbol)
    if tf == "weekly":
        df = to_weekly(df)
    return df


def make_features_with_market(stock_df: pd.DataFrame, spy_df: pd.DataFrame, qqq_df: pd.DataFrame) -> pd.DataFrame:
    """
    Build features for the stock, plus market context (SPY, QQQ).
    Predict next period close.
    """
    s = stock_df[["Date", "Open", "High", "Low", "Close", "Volume"]].copy()
    spy = spy_df[["Date", "Close"]].rename(columns={"Close": "SPY_Close"})
    qqq = qqq_df[["Date", "Close"]].rename(columns={"Close": "QQQ_Close"})

    # Merge on Date
    out = s.merge(spy, on="Date", how="left").merge(qqq, on="Date", how="left")

    # Forward fill in case of missing market rows (holidays/data gaps)
    out["SPY_Close"] = out["SPY_Close"].ffill()
    out["QQQ_Close"] = out["QQQ_Close"].ffill()

    # Basic stock features
    out["ret_1"] = out["Close"].pct_change(1)
    out["ret_5"] = out["Close"].pct_change(5)
    out["ma_5"] = out["Close"].rolling(5).mean()
    out["ma_10"] = out["Close"].rolling(10).mean()
    out["vol_10"] = out["Close"].rolling(10).std()
    out["volume_ma_10"] = out["Volume"].rolling(10).mean()

    # Market features
    out["spy_ret_1"] = out["SPY_Close"].pct_change(1)
    out["qqq_ret_1"] = out["QQQ_Close"].pct_change(1)

    # Relative strength features (stock minus market)
    out["rel_spy_1"] = out["ret_1"] - out["spy_ret_1"]
    out["rel_qqq_1"] = out["ret_1"] - out["qqq_ret_1"]

    # Rolling correlation to SPY (how “market-driven” it’s been)
    out["corr_spy_20"] = out["ret_1"].rolling(20).corr(out["spy_ret_1"])

    # Target = next period close
    out["target_next_close"] = out["Close"].shift(-1)

    out = out.dropna().reset_index(drop=True)
    return out


# ----------------------------
# Backtest + tuning (Option A)
# ----------------------------

def _walk_forward_backtest(
    feat: pd.DataFrame,
    feature_cols: list[str],
    target_col: str,
    params: dict,
    max_test_points: int = 50,
    retrain_every: int = 5,
) -> dict[str, Any]:
    """Expanding-window walk-forward backtest (fast).

    To keep it fast:
      - evaluates only the most recent `max_test_points` steps
      - retrains only every `retrain_every` steps
    """
    n = len(feat)
    if n < 120:
        return {"ok": False, "reason": "not_enough_data"}

    test_points = int(min(max_test_points, max(10, n // 10)))
    start = n - test_points

    y_true: list[float] = []
    y_pred: list[float] = []
    dir_hits = 0

    model = None

    for i in range(start, n):
        X_train = feat.iloc[:i][feature_cols].values
        y_train = feat.iloc[:i][target_col].values

        if (model is None) or ((i - start) % retrain_every == 0):
            model = RandomForestRegressor(
                n_estimators=int(params.get("n_estimators", 140)),
                random_state=42,
                n_jobs=-1,
                max_depth=params.get("max_depth", 10),
                min_samples_leaf=params.get("min_samples_leaf", 2),
                max_features=params.get("max_features", "sqrt"),
            )
            model.fit(X_train, y_train)

        x_i = feat.iloc[i][feature_cols].values.reshape(1, -1)
        pred_i = float(model.predict(x_i)[0])
        true_i = float(feat.iloc[i][target_col])

        y_true.append(true_i)
        y_pred.append(pred_i)

        prev_close = float(feat.iloc[i - 1]["Close"]) if i - 1 >= 0 else float(feat.iloc[i]["Close"])
        if (pred_i - prev_close) * (true_i - prev_close) >= 0:
            dir_hits += 1

    y_true_arr = np.array(y_true)
    y_pred_arr = np.array(y_pred)

    mae = float(np.mean(np.abs(y_true_arr - y_pred_arr)))
    mape = float(np.mean(np.abs((y_true_arr - y_pred_arr) / np.maximum(1e-9, np.abs(y_true_arr)))))
    dir_acc = float(dir_hits / max(1, len(y_true)))

    return {
        "ok": True,
        "points": int(len(y_true)),
        "mae": mae,
        "mape": mape,
        "direction_accuracy": dir_acc,
    }


def _tune_params_for_symbol(feat: pd.DataFrame, feature_cols: list[str]) -> dict[str, Any]:
    """Try a small param grid and pick best by MAPE (then MAE)."""
    grid = [
        {"n_estimators": 120, "max_depth": 10, "min_samples_leaf": 2, "max_features": "sqrt"},
        {"n_estimators": 160, "max_depth": 12, "min_samples_leaf": 2, "max_features": "sqrt"},
        {"n_estimators": 180, "max_depth": 14, "min_samples_leaf": 2, "max_features": "sqrt"},
        {"n_estimators": 160, "max_depth": 12, "min_samples_leaf": 3, "max_features": "sqrt"},
    ]

    best = None
    for p in grid:
        bt = _walk_forward_backtest(
            feat=feat,
            feature_cols=feature_cols,
            target_col="target_next_close",
            params=p,
            max_test_points=40,
            retrain_every=6,
        )
        if not bt.get("ok"):
            continue

        score = (bt["mape"], bt["mae"])
        if best is None or score < best["score"]:
            best = {"params": p, "backtest": bt, "score": score}

    if best is None:
        return {
            "params": {"n_estimators": 160, "max_depth": 12, "min_samples_leaf": 2, "max_features": "sqrt"},
            "backtest": {"ok": False, "reason": "tune_failed"},
        }

    return {
        "params": best["params"],
        "backtest": best["backtest"],
    }


def cache_get(cache: dict, key: str, ttl: int):
    now = time.time()
    if key in cache:
        ts, val = cache[key]
        if (now - ts) < ttl:
            return val
        else:
            del cache[key]
    return None


def cache_set(cache: dict, key: str, val: Any):
    cache[key] = (time.time(), val)


@app.get("/health")
def health():
    return {"ok": True}


@app.get("/history/{symbol}")
def history(symbol: str, timeframe: str = "daily", points: int = 200):
    """
    Returns OHLCV candles for charting.
    Cached for speed.
    """
    symbol = symbol.upper().strip()
    if not symbol.isalnum():
        raise HTTPException(status_code=400, detail="Symbol must be letters/numbers only")

    tf = normalize_timeframe(timeframe)
    key = f"{symbol}:{tf}:{points}"

    cached = cache_get(_hist_cache, key, HIST_CACHE_TTL_SEC)
    if cached is not None:
        return cached

    df = get_symbol_df(symbol, tf)

    if len(df) < 30:
        raise HTTPException(status_code=400, detail="Not enough history")

    df = df.tail(points).copy()

    candles = [
        {
            "time": d.strftime("%Y-%m-%d"),
            "open": float(o),
            "high": float(h),
            "low": float(l),
            "close": float(c),
            "volume": float(v),
        }
        for d, o, h, l, c, v in zip(
            df["Date"], df["Open"], df["High"], df["Low"], df["Close"], df["Volume"]
        )
    ]

    payload = {"symbol": symbol, "timeframe": tf, "candles": candles}
    cache_set(_hist_cache, key, payload)
    return payload


@app.post("/predict")
def predict(req: PredictRequest):
    """
    Prediction with market context:
    - Fetch stock + SPY + QQQ from Stooq
    - Build features (stock indicators + market indicators)
    - Train baseline model
    - Cache the result for 15 minutes
    """
    symbol = req.symbol.upper().strip()
    if not symbol.isalnum():
        raise HTTPException(status_code=400, detail="Symbol must be letters/numbers only (e.g., AAPL)")

    tf = normalize_timeframe(req.timeframe)
    cache_key = f"{symbol}:{tf}"

    cached = cache_get(_pred_cache, cache_key, PRED_CACHE_TTL_SEC)
    if cached is not None:
        return cached

    # Fetch data
    stock_df = get_symbol_df(symbol, tf)

    # Latest date key (used for model/tune caching)
    last_date = stock_df["Date"].iloc[-1]
    last_date_key = last_date.strftime("%Y-%m-%d") if hasattr(last_date, "strftime") else str(last_date)

    spy_df = get_symbol_df("SPY", tf)
    qqq_df = get_symbol_df("QQQ", tf)

    if len(stock_df) < 160 or len(spy_df) < 160 or len(qqq_df) < 160:
        raise HTTPException(status_code=400, detail="Not enough history to model")

    feat = make_features_with_market(stock_df, spy_df, qqq_df)

    # Keep computations fast: use a recent window of feature rows
    feat = feat.tail(900).reset_index(drop=True)

    feature_cols = [
        "ret_1", "ret_5", "ma_5", "ma_10", "vol_10", "volume_ma_10",
        "spy_ret_1", "qqq_ret_1", "rel_spy_1", "rel_qqq_1", "corr_spy_20",
    ]

    # Auto-tune (cached) using walk-forward backtest
    tune_key = f"tune:{symbol}:{tf}:{last_date_key}"
    tuned = cache_get(_tune_cache, tune_key, TUNE_CACHE_TTL_SEC)
    tune_cache_hit = tuned is not None
    if tuned is None:
        tuned = _tune_params_for_symbol(feat, feature_cols)
        cache_set(_tune_cache, tune_key, tuned)

    tuned_params = tuned.get("params") if isinstance(tuned, dict) else None
    bt_summary = tuned.get("backtest") if isinstance(tuned, dict) else None

    X = feat[feature_cols].values
    y = feat["target_next_close"].values

    # If we already trained a model for this (symbol, timeframe) and the latest candle
    # hasn't changed, reuse the model to make prediction instant.
    model_key = f"model:{symbol}:{tf}"
    model_cached = cache_get(_model_cache, model_key, MODEL_CACHE_TTL_SEC)

    model_cache_hit = False
    if isinstance(model_cached, dict) and model_cached.get("last_date") == last_date_key:
        model = model_cached.get("model")
        model_cache_hit = model is not None
    else:
        model = None

    if not model_cache_hit:
        # Use tuned params if available
        p = tuned_params or {"n_estimators": 180, "max_depth": 12, "min_samples_leaf": 2, "max_features": "sqrt"}
        model = RandomForestRegressor(
            n_estimators=int(p.get("n_estimators", 180)),
            random_state=42,
            n_jobs=-1,
            max_depth=p.get("max_depth", 12),
            min_samples_leaf=p.get("min_samples_leaf", 2),
            max_features=p.get("max_features", "sqrt"),
        )
        model.fit(X, y)
        cache_set(_model_cache, model_key, {
            "model": model,
            "last_date": last_date_key,
            "feature_cols": feature_cols,
        })

    latest = feat.iloc[-1]
    pred_next_close = float(model.predict(latest[feature_cols].values.reshape(1, -1))[0])

    last_close = float(stock_df["Close"].iloc[-1])

    # Range estimate from recent volatility
    rets = stock_df["Close"].pct_change().dropna()
    recent_vol = float(rets.rolling(20).std().dropna().iloc[-1]) if len(rets) >= 25 else float(rets.std())

    low = pred_next_close * (1 - recent_vol)
    high = pred_next_close * (1 + recent_vol)

    confidence = float(np.clip(1 - (recent_vol * 5), 0.05, 0.9))

    # Market summary
    spy_last = float(spy_df["Close"].iloc[-1])
    qqq_last = float(qqq_df["Close"].iloc[-1])
    spy_ret_1 = float((spy_df["Close"].pct_change().dropna().iloc[-1]) if len(spy_df) > 2 else 0.0)
    qqq_ret_1 = float((qqq_df["Close"].pct_change().dropna().iloc[-1]) if len(qqq_df) > 2 else 0.0)

    payload = {
        "symbol": symbol,
        "timeframe": tf,
        "last_close": round(last_close, 2),
        "prediction": round(pred_next_close, 2),
        "range_low": round(low, 2),
        "range_high": round(high, 2),
        "confidence": round(confidence, 2),
        "data_points": int(len(stock_df)),
        "source": "stooq",
        "market": {
            "SPY_last_close": round(spy_last, 2),
            "QQQ_last_close": round(qqq_last, 2),
            "SPY_ret_1": round(spy_ret_1 * 100, 2),  # percent
            "QQQ_ret_1": round(qqq_ret_1 * 100, 2),
        },
        "backtest": {
            "method": "walk_forward",
            "summary": bt_summary,
            "tune_cache_hit": bool(tune_cache_hit),
        },
        "cache": {"hit": False, "ttl_sec": PRED_CACHE_TTL_SEC, "model_hit": bool(model_cache_hit), "tune_hit": bool(tune_cache_hit)},
    }

    cache_set(_pred_cache, cache_key, payload)
    return payload


# ----------------------------
# News helpers
# ----------------------------

def _mk_id(url: str, title: str) -> str:
    raw = (url or "") + "|" + (title or "")
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:12]


def _fmt_time(s: str | None) -> str:
    if not s:
        return ""
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        return dt.strftime("%b %d, %Y %H:%M UTC")
    except Exception:
        return s


@app.get("/news")
def news(mode: str = "market", symbol: str | None = None, limit: int = 6):
    """
    Market / ticker news endpoint.

    Placeholder mode:
      - If MARKET_AUX_TOKEN is not set, returns placeholder items.

    Live mode (Marketaux):
      - US-only, English news.
      - If mode=ticker, requires `symbol`.
    """
    mode = (mode or "market").strip().lower()
    if mode not in ("market", "ticker"):
        raise HTTPException(status_code=400, detail="mode must be market or ticker")

    sym = (symbol or "").upper().strip()
    if mode == "ticker" and (not sym or not sym.isalnum()):
        raise HTTPException(status_code=400, detail="symbol is required for ticker mode (e.g., AAPL)")

    limit = int(max(1, min(limit, 10)))
    cache_key = f"{mode}:{sym}:{limit}"

    cached = cache_get(_news_cache, cache_key, NEWS_CACHE_TTL_SEC)
    if cached is not None:
        return cached

    token = os.getenv("MARKET_AUX_TOKEN")

    # ---------- Placeholder ----------
    if not token:
        if mode == "market":
            items = [
                {
                    "id": "m1",
                    "title": "Placeholder: Stocks mixed as traders weigh rates and earnings",
                    "source": "Placeholder News",
                    "time": "Today",
                    "summary": "Set MARKET_AUX_TOKEN to enable live US market headlines.",
                    "url": None,
                },
                {
                    "id": "m2",
                    "title": "Placeholder: Volatility elevated ahead of key macro prints",
                    "source": "Placeholder News",
                    "time": "Today",
                    "summary": "Once enabled, this feed will return real clickable articles.",
                    "url": None,
                },
            ]
        else:
            items = [
                {
                    "id": "t1",
                    "title": f"Placeholder: {sym} — latest company headlines",
                    "source": "Placeholder News",
                    "time": "Today",
                    "summary": "Set MARKET_AUX_TOKEN to enable live ticker-specific headlines.",
                    "url": None,
                }
            ]

        payload = {
            "mode": mode,
            "symbol": sym if sym else None,
            "items": items,
            "source": "placeholder",
        }
        cache_set(_news_cache, cache_key, payload)
        return payload

    # ---------- Live Marketaux ----------
    url = "https://api.marketaux.com/v1/news/all"
    params = {
        "api_token": token,
        "countries": "us",
        "language": "en",
        "filter_entities": "true",
        "limit": str(limit),
    }
    if mode == "ticker":
        params["symbols"] = sym

    try:
        r = requests.get(url, params=params, timeout=20)
        if r.status_code != 200:
            raise HTTPException(status_code=502, detail=f"News provider error: {r.status_code}")
        j = r.json()
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"News provider request failed: {e}")

    data = j.get("data") or []
    items = []
    for a in data:
        title = a.get("title") or ""
        src = a.get("source") or "Marketaux"
        published = a.get("published_at") or ""
        desc = a.get("description") or a.get("snippet") or a.get("summary") or ""
        link = a.get("url")

        items.append(
            {
                "id": _mk_id(link or "", title),
                "title": title,
                "source": src,
                "time": _fmt_time(published),
                "summary": (desc[:220] + "…") if len(desc) > 220 else desc,
                "url": link,
            }
        )

    payload = {
        "mode": mode,
        "symbol": sym if sym else None,
        "items": items,
        "source": "marketaux",
    }
    cache_set(_news_cache, cache_key, payload)
    return payload

 
# ----------------------------
# Symbols: S&P 500 (free source)
# ----------------------------

def _fetch_sp500_from_free_csv() -> list[dict[str, Any]]:
    """Fetch S&P 500 constituents from a free CSV dataset.

    This avoids HTML parsing dependencies that can fail on some hosts.
    """
    url = "https://raw.githubusercontent.com/datasets/s-and-p-500-companies/master/data/constituents.csv"

    r = requests.get(url, timeout=20)
    r.raise_for_status()

    df = pd.read_csv(StringIO(r.text))

    # Expected columns: Symbol, Name, Sector
    cols = {str(c).lower(): c for c in df.columns}
    sym_col = cols.get("symbol")
    name_col = cols.get("name")
    sector_col = cols.get("sector")

    if not sym_col or not name_col:
        raise RuntimeError("Unexpected CSV schema for S&P 500 constituents")

    out: list[dict[str, Any]] = []
    for _, row in df.iterrows():
        sym = str(row[sym_col]).strip().upper()
        sym_alt = sym.replace(".", "-")  # BRK.B -> BRK-B (often needed)

        name = str(row[name_col]).strip()
        sector = str(row[sector_col]).strip() if sector_col else ""

        out.append({
            "symbol": sym,
            "symbol_alt": sym_alt if sym_alt != sym else None,
            "name": name,
            "sector": sector,
        })

    # Deduplicate by symbol
    seen = set()
    dedup = []
    for it in out:
        if it["symbol"] in seen:
            continue
        seen.add(it["symbol"])
        dedup.append(it)

    return dedup


@app.get("/symbols/sp500")
def symbols_sp500(limit: int = 2000):
    """Return S&P 500 constituents for dropdown search. Cached for 24 hours."""
    cache_key = "sp500"
    cached = cache_get(_symbols_cache, cache_key, SYMBOLS_CACHE_TTL_SEC)
    if cached is not None:
        return cached

    try:
        items = _fetch_sp500_from_free_csv()
        source = "free_csv"
    except Exception:
        # Fallback if CSV is temporarily unavailable
        items = [
            {"symbol": "AAPL", "symbol_alt": None, "name": "Apple Inc.", "sector": "Information Technology"},
            {"symbol": "MSFT", "symbol_alt": None, "name": "Microsoft", "sector": "Information Technology"},
            {"symbol": "AMZN", "symbol_alt": None, "name": "Amazon", "sector": "Consumer Discretionary"},
            {"symbol": "NVDA", "symbol_alt": None, "name": "NVIDIA", "sector": "Information Technology"},
            {"symbol": "GOOGL", "symbol_alt": None, "name": "Alphabet (Class A)", "sector": "Communication Services"},
        ]
        source = "fallback"

    # Apply limit (default allows all ~500)
    limit = int(max(1, min(limit, 2000)))
    items_out = items[:limit]

    payload = {
        "items": items_out,
        "source": source,
        "cache_ttl_sec": SYMBOLS_CACHE_TTL_SEC,
        "count": len(items_out),
    }
    cache_set(_symbols_cache, cache_key, payload)
    return payload
