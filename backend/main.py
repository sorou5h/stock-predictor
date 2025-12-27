from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import pandas as pd
import numpy as np
import requests
from io import StringIO
from sklearn.ensemble import RandomForestRegressor
import time


app = FastAPI(title="Stock Predictor API")

# Dev CORS: allow local frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://127.0.0.1:3000",
    ],
    allow_credentials=True,
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


def cache_get(cache: dict, key: str, ttl: int):
    now = time.time()
    if key in cache:
        ts, val = cache[key]
        if (now - ts) < ttl:
            return val
        else:
            del cache[key]
    return None


def cache_set(cache: dict, key: str, val: dict):
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
    spy_df = get_symbol_df("SPY", tf)
    qqq_df = get_symbol_df("QQQ", tf)

    if len(stock_df) < 160 or len(spy_df) < 160 or len(qqq_df) < 160:
        raise HTTPException(status_code=400, detail="Not enough history to model")

    feat = make_features_with_market(stock_df, spy_df, qqq_df)

    feature_cols = [
        "ret_1", "ret_5", "ma_5", "ma_10", "vol_10", "volume_ma_10",
        "spy_ret_1", "qqq_ret_1", "rel_spy_1", "rel_qqq_1", "corr_spy_20",
    ]

    X = feat[feature_cols].values
    y = feat["target_next_close"].values

    model = RandomForestRegressor(
        n_estimators=400,
        random_state=42,
        n_jobs=-1
    )
    model.fit(X, y)

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
        "cache": {"hit": False, "ttl_sec": PRED_CACHE_TTL_SEC},
    }

    cache_set(_pred_cache, cache_key, payload)
    return payload
