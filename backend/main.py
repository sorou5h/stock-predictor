from __future__ import annotations
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Any, Optional, Literal, List
import pandas as pd
import numpy as np
import requests
from io import StringIO
from sklearn.ensemble import RandomForestRegressor
import time

# News endpoint imports
import os
import hashlib
import json
from datetime import datetime

# ----------------------------
# Optional PyTorch (safe import)
# ----------------------------
TORCH_AVAILABLE = False
try:
    import torch
    import torch.nn as nn
    TORCH_AVAILABLE = True
except Exception:
    TORCH_AVAILABLE = False


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
# Storage (models + bias)
# ----------------------------
MODEL_DIR = os.getenv("MODEL_DIR", "./model_store")
os.makedirs(MODEL_DIR, exist_ok=True)

def _safe_sym_tf(symbol: str, tf: str) -> str:
    return f"{symbol.upper().strip()}_{tf.lower().strip()}"

def _model_path(symbol: str, tf: str, model_type: str) -> str:
    key = _safe_sym_tf(symbol, tf)
    return os.path.join(MODEL_DIR, f"{key}_{model_type}.pkl")

def _torch_path(symbol: str, tf: str) -> str:
    key = _safe_sym_tf(symbol, tf)
    return os.path.join(MODEL_DIR, f"{key}_torch.pt")

def _bias_path(symbol: str, tf: str) -> str:
    key = _safe_sym_tf(symbol, tf)
    return os.path.join(MODEL_DIR, f"{key}_bias.json")


# ----------------------------
# Simple in-memory cache (MVP)
# ----------------------------
PRED_CACHE_TTL_SEC = 15 * 60  # 15 minutes
HIST_CACHE_TTL_SEC = 15 * 60
_pred_cache: dict[str, tuple[float, dict]] = {}
_hist_cache: dict[str, tuple[float, dict]] = {}

# Forecast cache: multi-horizon forecasts
FORECAST_CACHE_TTL_SEC = 15 * 60  # 15 minutes
_forecast_cache: dict[str, tuple[float, dict]] = {}

# Data cache: avoid re-downloading the same CSV repeatedly
DATA_CACHE_TTL_SEC = 15 * 60  # 15 minutes
_data_cache: dict[str, tuple[float, pd.DataFrame]] = {}

# Model cache: avoid retraining if the latest candle hasn't changed
MODEL_CACHE_TTL_SEC = 60 * 60  # 1 hour
_model_cache: dict[str, tuple[float, Any]] = {}
# stored value: {"model": fitted_model, "last_date": "YYYY-MM-DD", "feature_cols": [...], "model_type": "rf"|"torch"} 

# Bias cache: fast “learn from mistakes” adjustment
BIAS_CACHE_TTL_SEC = 24 * 60 * 60  # 24 hours
_bias_cache: dict[str, tuple[float, Any]] = {}
# stored value: {"bias": float, "updated_at": "...", "alpha": float, "last_date_key": "..."} 

# Tune cache: avoid re-running backtests constantly
TUNE_CACHE_TTL_SEC = 6 * 60 * 60  # 6 hours
_tune_cache: dict[str, tuple[float, Any]] = {}

# Backtest cache: store evaluation metrics so users don't wait every time
BACKTEST_CACHE_TTL_SEC = 24 * 60 * 60  # 24 hours
_backtest_cache: dict[str, tuple[float, Any]] = {}

# Turn on expensive backtest/tuning only when explicitly enabled
ENABLE_TUNING = os.getenv("ENABLE_TUNING", "0") == "1"

# News cache
NEWS_CACHE_TTL_SEC = 10 * 60  # 10 minutes
_news_cache: dict[str, tuple[float, dict]] = {}

# Symbols cache (S&P 500 list)
SYMBOLS_CACHE_TTL_SEC = 24 * 60 * 60  # 24 hours
_symbols_cache: dict[str, tuple[float, dict]] = {}

# Default model type (can override per request)
DEFAULT_MODEL_TYPE = os.getenv("MODEL_TYPE", "rf").strip().lower()
if DEFAULT_MODEL_TYPE not in ("rf", "torch"):
    DEFAULT_MODEL_TYPE = "rf"


# ----------------------------
# Request models
# ----------------------------
class PredictRequest(BaseModel):
    symbol: str
    timeframe: str = "daily"  # "daily" or "weekly"
    model: Optional[Literal["rf", "torch"]] = None  # optional override

class ForecastRequest(BaseModel):
    symbol: str
    timeframe: str = "daily"  # "daily" or "weekly"
    horizons: Optional[List[int]] = None  # e.g. [1,3,5]

def normalize_timeframe(tf: str) -> str:
    tf = (tf or "").strip().lower()
    if tf not in ("daily", "weekly"):
        raise HTTPException(status_code=400, detail="timeframe must be daily or weekly")
    return tf

def default_horizons(tf: str) -> list[int]:
    return [1, 3, 5] if tf == "daily" else [1, 2, 4]

def clamp(x: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, x))


# ----------------------------
# Features
# ----------------------------
def get_feature_cols() -> list[str]:
    return [
        "ret_1", "ret_5", "ma_5", "ma_10", "vol_10", "volume_ma_10",
        "spy_ret_1", "qqq_ret_1", "rel_spy_1", "rel_qqq_1", "corr_spy_20",
    ]

def build_rf(params: Optional[dict] = None) -> RandomForestRegressor:
    p = params or {}
    return RandomForestRegressor(
        n_estimators=int(p.get("n_estimators", 180)),
        random_state=42,
        n_jobs=-1,
        max_depth=p.get("max_depth", 12),
        min_samples_leaf=p.get("min_samples_leaf", 2),
        max_features=p.get("max_features", "sqrt"),
    )


# ----------------------------
# PyTorch model (small MLP regressor)
# ----------------------------
if TORCH_AVAILABLE:
    class TorchMLP(nn.Module):
        def __init__(self, in_dim: int):
            super().__init__()
            self.net = nn.Sequential(
                nn.Linear(in_dim, 64),
                nn.ReLU(),
                nn.Linear(64, 64),
                nn.ReLU(),
                nn.Linear(64, 1),
            )

        def forward(self, x):
            return self.net(x)
else:
    # Dummy placeholder to prevent NameError during import when torch isn't installed.
    # Any attempt to train/predict with torch will raise a clear error via helpers below.
    TorchMLP = None  # type: ignore


def _torch_train_and_fit(X: np.ndarray, y: np.ndarray, epochs: int = 60, lr: float = 1e-3) -> Any:
    """Train a tiny MLP quickly on CPU. Returns dict with model + normalization."""
    if not TORCH_AVAILABLE:
        raise RuntimeError("torch_not_installed")

    device = torch.device("cpu")

    X = X.astype(np.float32)
    y = y.astype(np.float32).reshape(-1, 1)

    # normalize features
    mu = X.mean(axis=0)
    sig = X.std(axis=0)
    sig = np.where(sig < 1e-8, 1.0, sig)
    Xn = (X - mu) / sig

    model = TorchMLP(in_dim=Xn.shape[1]).to(device)  # type: ignore
    opt = torch.optim.Adam(model.parameters(), lr=lr)
    loss_fn = nn.SmoothL1Loss()

    xb = torch.from_numpy(Xn).to(device)
    yb = torch.from_numpy(y).to(device)

    model.train()
    for _ in range(int(epochs)):
        opt.zero_grad()
        pred = model(xb)
        loss = loss_fn(pred, yb)
        loss.backward()
        opt.step()

    return {"model": model, "mu": mu, "sig": sig}


def _torch_predict(fit_obj: Any, x: np.ndarray) -> float:
    if not TORCH_AVAILABLE:
        raise RuntimeError("torch_not_installed")
    model: nn.Module = fit_obj["model"]
    mu = fit_obj["mu"]
    sig = fit_obj["sig"]
    x = x.astype(np.float32).reshape(1, -1)
    xn = (x - mu) / sig
    with torch.no_grad():
        model.eval()
        out = model(torch.from_numpy(xn)).cpu().numpy().reshape(-1)[0]
    return float(out)


def _torch_save(fit_obj: Any, path: str, meta: dict):
    """Save torch weights + normalization + meta."""
    if not TORCH_AVAILABLE:
        return
    payload = {
        "state_dict": fit_obj["model"].state_dict(),
        "mu": fit_obj["mu"],
        "sig": fit_obj["sig"],
        "meta": meta,
    }
    torch.save(payload, path)


def _torch_load(path: str) -> Optional[Any]:
    if not TORCH_AVAILABLE:
        return None
    if not os.path.exists(path):
        return None
    try:
        payload = torch.load(path, map_location="cpu")
        mu = payload["mu"]
        sig = payload["sig"]
        meta = payload.get("meta") or {}
        in_dim = int(len(mu))
        model = TorchMLP(in_dim=in_dim)  # type: ignore
        model.load_state_dict(payload["state_dict"])
        return {"model": model, "mu": mu, "sig": sig, "meta": meta}
    except Exception:
        return None


# ----------------------------
# Cache helpers
# ----------------------------
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

def _date_key_today_utc() -> str:
    return datetime.utcnow().strftime("%Y-%m-%d")


# ----------------------------
# Data fetching
# ----------------------------
def fetch_stooq_ohlcv(symbol: str) -> pd.DataFrame:
    cache_key = f"stooq:{symbol.lower().strip()}:daily"
    cached = cache_get(_data_cache, cache_key, DATA_CACHE_TTL_SEC)
    if cached is not None:
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
    s = stock_df[["Date", "Open", "High", "Low", "Close", "Volume"]].copy()
    spy = spy_df[["Date", "Close"]].rename(columns={"Close": "SPY_Close"})
    qqq = qqq_df[["Date", "Close"]].rename(columns={"Close": "QQQ_Close"})

    out = s.merge(spy, on="Date", how="left").merge(qqq, on="Date", how="left")
    out["SPY_Close"] = out["SPY_Close"].ffill()
    out["QQQ_Close"] = out["QQQ_Close"].ffill()

    out["ret_1"] = out["Close"].pct_change(1)
    out["ret_5"] = out["Close"].pct_change(5)
    out["ma_5"] = out["Close"].rolling(5).mean()
    out["ma_10"] = out["Close"].rolling(10).mean()
    out["vol_10"] = out["Close"].rolling(10).std()
    out["volume_ma_10"] = out["Volume"].rolling(10).mean()

    out["spy_ret_1"] = out["SPY_Close"].pct_change(1)
    out["qqq_ret_1"] = out["QQQ_Close"].pct_change(1)

    out["rel_spy_1"] = out["ret_1"] - out["spy_ret_1"]
    out["rel_qqq_1"] = out["ret_1"] - out["qqq_ret_1"]

    out["corr_spy_20"] = out["ret_1"].rolling(20).corr(out["spy_ret_1"])

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

    return {"params": best["params"], "backtest": best["backtest"]}


# ----------------------------
# Bias “learning” (fast)
# ----------------------------
def _load_bias(symbol: str, tf: str) -> dict[str, Any]:
    key = f"bias:{symbol}:{tf}"
    cached = cache_get(_bias_cache, key, BIAS_CACHE_TTL_SEC)
    if cached is not None:
        return cached

    path = _bias_path(symbol, tf)
    if os.path.exists(path):
        try:
            with open(path, "r", encoding="utf-8") as f:
                obj = json.load(f)
            if isinstance(obj, dict) and "bias" in obj:
                cache_set(_bias_cache, key, obj)
                return obj
        except Exception:
            pass

    obj = {"bias": 0.0, "alpha": 0.20, "updated_at": None, "last_date_key": None}
    cache_set(_bias_cache, key, obj)
    return obj

def _save_bias(symbol: str, tf: str, obj: dict[str, Any]) -> None:
    key = f"bias:{symbol}:{tf}"
    cache_set(_bias_cache, key, obj)
    try:
        with open(_bias_path(symbol, tf), "w", encoding="utf-8") as f:
            json.dump(obj, f)
    except Exception:
        pass

def _update_bias_from_latest_known(
    symbol: str,
    tf: str,
    feat: pd.DataFrame,
    feature_cols: list[str],
    model_type: str,
    model_obj: Any,
    last_date_key: str,
) -> dict[str, Any]:
    """
    Update bias using a *known* target:
    Use second-last feature row to predict its next_close (= last close),
    then compare to actual last close, update EMA bias.
    """
    if len(feat) < 5:
        return _load_bias(symbol, tf)

    bias_obj = _load_bias(symbol, tf)
    if bias_obj.get("last_date_key") == last_date_key:
        return bias_obj  # already updated for this latest candle

    # second-last row predicts last close
    row = feat.iloc[-2]
    true_next = float(row["target_next_close"])

    x = row[feature_cols].values.astype(float)

    try:
        if model_type == "torch":
            pred_next = float(_torch_predict(model_obj, x))
        else:
            pred_next = float(model_obj.predict(x.reshape(1, -1))[0])
    except Exception:
        return bias_obj

    err = true_next - pred_next  # positive => model too low
    alpha = float(bias_obj.get("alpha", 0.20))
    old_bias = float(bias_obj.get("bias", 0.0))
    new_bias = (1 - alpha) * old_bias + alpha * err

    bias_obj = {
        "bias": float(new_bias),
        "alpha": alpha,
        "updated_at": datetime.utcnow().isoformat() + "Z",
        "last_date_key": last_date_key,
        "last_err": float(err),
    }
    _save_bias(symbol, tf, bias_obj)
    return bias_obj


# ----------------------------
# Routes
# ----------------------------
@app.get("/health")
def health():
    return {
        "ok": True,
        "torch_available": TORCH_AVAILABLE,
        "default_model": DEFAULT_MODEL_TYPE,
    }

@app.get("/history/{symbol}")
def history(symbol: str, timeframe: str = "daily", points: int = 200):
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
    symbol = req.symbol.upper().strip()
    if not symbol.isalnum():
        raise HTTPException(status_code=400, detail="Symbol must be letters/numbers only (e.g., AAPL)")

    tf = normalize_timeframe(req.timeframe)

    requested_model = (req.model or DEFAULT_MODEL_TYPE).strip().lower()
    if requested_model not in ("rf", "torch"):
        requested_model = "rf"
    if requested_model == "torch" and not TORCH_AVAILABLE:
        requested_model = "rf"  # auto fallback

    # cache key includes model type so switching doesn't clash
    cache_key = f"{symbol}:{tf}:{requested_model}"

    cached = cache_get(_pred_cache, cache_key, PRED_CACHE_TTL_SEC)
    if cached is not None:
        return cached

    # Fetch data
    stock_df = get_symbol_df(symbol, tf)

    last_date = stock_df["Date"].iloc[-1]
    last_date_key = last_date.strftime("%Y-%m-%d") if hasattr(last_date, "strftime") else str(last_date)

    spy_df = get_symbol_df("SPY", tf)
    qqq_df = get_symbol_df("QQQ", tf)

    if len(stock_df) < 160 or len(spy_df) < 160 or len(qqq_df) < 160:
        raise HTTPException(status_code=400, detail="Not enough history to model")

    feat = make_features_with_market(stock_df, spy_df, qqq_df)
    feat = feat.tail(600).reset_index(drop=True)

    feature_cols = get_feature_cols()

    tuned_params = None
    bt_summary = None
    tune_cache_hit = False

    if ENABLE_TUNING and requested_model == "rf":
        tune_key = f"tune:{symbol}:{tf}:{last_date_key}"
        tuned = cache_get(_tune_cache, tune_key, TUNE_CACHE_TTL_SEC)
        tune_cache_hit = tuned is not None
        if tuned is None:
            tuned = _tune_params_for_symbol(feat, feature_cols)
            cache_set(_tune_cache, tune_key, tuned)

        tuned_params = tuned.get("params") if isinstance(tuned, dict) else None
        bt_summary = tuned.get("backtest") if isinstance(tuned, dict) else None

    X = feat[feature_cols].values.astype(float)
    y = feat["target_next_close"].values.astype(float)

    # --- Model caching (RAM) ---
    model_key = f"model:{symbol}:{tf}:{requested_model}"
    model_cached = cache_get(_model_cache, model_key, MODEL_CACHE_TTL_SEC)

    model_cache_hit = False
    model_obj = None

    if isinstance(model_cached, dict) and model_cached.get("last_date") == last_date_key:
        model_obj = model_cached.get("model")
        model_cache_hit = model_obj is not None

    # --- Disk load (fast start) ---
    if not model_cache_hit:
        if requested_model == "torch" and TORCH_AVAILABLE:
            loaded = _torch_load(_torch_path(symbol, tf))
            if loaded and (loaded.get("meta") or {}).get("last_date") == last_date_key:
                model_obj = loaded
                model_cache_hit = True
        elif requested_model == "rf":
            # RF persistence could be added, but sklearn pickle in Render can be flaky; keeping RAM cache for now.
            pass

    # --- Train if needed ---
    if not model_cache_hit:
        if requested_model == "torch":
            # keep it fast for MVP
            model_obj = _torch_train_and_fit(X, y, epochs=60, lr=1e-3)
            # save torch model
            _torch_save(model_obj, _torch_path(symbol, tf), meta={"last_date": last_date_key, "feature_cols": feature_cols})
        else:
            p = tuned_params or {"n_estimators": 140, "max_depth": 12, "min_samples_leaf": 2, "max_features": "sqrt"}
            model_obj = RandomForestRegressor(
                n_estimators=int(p.get("n_estimators", 140)),
                random_state=42,
                n_jobs=-1,
                max_depth=p.get("max_depth", 12),
                min_samples_leaf=p.get("min_samples_leaf", 2),
                max_features=p.get("max_features", "sqrt"),
            )
            model_obj.fit(X, y)

        cache_set(_model_cache, model_key, {
            "model": model_obj,
            "last_date": last_date_key,
            "feature_cols": feature_cols,
            "model_type": requested_model,
        })

    # --- Update bias (“learn from mistakes”) using known last day ---
    bias_obj = _update_bias_from_latest_known(
        symbol=symbol,
        tf=tf,
        feat=feat,
        feature_cols=feature_cols,
        model_type=requested_model,
        model_obj=model_obj,
        last_date_key=last_date_key,
    )
    bias = float(bias_obj.get("bias", 0.0))

    # --- Predict next close ---
    latest = feat.iloc[-1]
    x_latest = latest[feature_cols].values.astype(float)

    if requested_model == "torch":
        pred_next_close = float(_torch_predict(model_obj, x_latest))
    else:
        pred_next_close = float(model_obj.predict(x_latest.reshape(1, -1))[0])

    # Apply bias correction (learning)
    pred_next_close_adj = pred_next_close + bias

    last_close = float(stock_df["Close"].iloc[-1])

    # Range estimate from recent volatility
    rets = stock_df["Close"].pct_change().dropna()
    recent_vol = float(rets.rolling(20).std().dropna().iloc[-1]) if len(rets) >= 25 else float(rets.std())
    if not np.isfinite(recent_vol) or recent_vol <= 0:
        recent_vol = 0.02

    low = pred_next_close_adj * (1 - recent_vol)
    high = pred_next_close_adj * (1 + recent_vol)

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
        "prediction": round(pred_next_close_adj, 2),
        "range_low": round(low, 2),
        "range_high": round(high, 2),
        "confidence": round(confidence, 2),
        "data_points": int(len(stock_df)),
        "source": "stooq",
        "model_type": requested_model,
        "torch_available": TORCH_AVAILABLE,
        "learning": {
            "bias": round(bias, 4),
            "bias_alpha": float(bias_obj.get("alpha", 0.20)),
            "bias_last_err": float(bias_obj.get("last_err", 0.0)) if "last_err" in bias_obj else None,
            "bias_updated_at": bias_obj.get("updated_at"),
        },
        "market": {
            "SPY_last_close": round(spy_last, 2),
            "QQQ_last_close": round(qqq_last, 2),
            "SPY_ret_1": round(spy_ret_1 * 100, 2),
            "QQQ_ret_1": round(qqq_ret_1 * 100, 2),
        },
        "backtest": {
            "enabled": bool(ENABLE_TUNING and requested_model == "rf"),
            "method": "walk_forward" if (ENABLE_TUNING and requested_model == "rf") else None,
            "summary": bt_summary,
            "tune_cache_hit": bool(tune_cache_hit),
        },
        "cache": {
            "hit": False,
            "ttl_sec": PRED_CACHE_TTL_SEC,
            "model_hit": bool(model_cache_hit),
            "tune_hit": bool(tune_cache_hit),
        },
    }

    cache_set(_pred_cache, cache_key, payload)
    return payload


@app.post("/forecast")
def forecast(req: ForecastRequest):
    symbol = (req.symbol or "").upper().strip()
    if not symbol.isalnum():
        raise HTTPException(status_code=400, detail="Symbol must be letters/numbers only (e.g., AAPL)")

    tf = normalize_timeframe(req.timeframe)

    horizons = req.horizons or default_horizons(tf)
    try:
        horizons = [int(h) for h in horizons]
    except Exception:
        horizons = default_horizons(tf)

    horizons = [h for h in horizons if 1 <= h <= 20]
    horizons = sorted(list(dict.fromkeys(horizons)))
    if not horizons:
        horizons = default_horizons(tf)

    stock_df = get_symbol_df(symbol, tf)
    last_date = stock_df["Date"].iloc[-1]
    last_date_key = last_date.strftime("%Y-%m-%d") if hasattr(last_date, "strftime") else str(last_date)

    cache_key = f"{symbol}:{tf}:{last_date_key}:{','.join(str(h) for h in horizons)}"
    cached = cache_get(_forecast_cache, cache_key, FORECAST_CACHE_TTL_SEC)
    if cached is not None:
        return cached

    pred_payload = cache_get(_pred_cache, f"{symbol}:{tf}:{DEFAULT_MODEL_TYPE}", PRED_CACHE_TTL_SEC)
    if pred_payload is None:
        pred_payload = predict(PredictRequest(symbol=symbol, timeframe=tf, model=DEFAULT_MODEL_TYPE))  # populates caches

    last_close = float(pred_payload.get("last_close", stock_df["Close"].iloc[-1]))
    pred_next = float(pred_payload.get("prediction", last_close))

    r1 = (pred_next / last_close - 1.0) if last_close else 0.0

    rets = stock_df["Close"].pct_change().dropna()
    vol = float(rets.rolling(20).std().dropna().iloc[-1]) if len(rets) >= 25 else float(rets.std())
    if not np.isfinite(vol) or vol <= 0:
        vol = 0.02

    items: list[dict[str, Any]] = []
    for h in horizons:
        pred_h = float(last_close * (1.0 + r1 * h))
        band = last_close * vol * (h ** 0.5) * 1.25
        range_low = float(pred_h - band)
        range_high = float(pred_h + band)

        change_pct = ((pred_h - last_close) / last_close) * 100 if last_close else 0.0
        conf = clamp(1.0 - (abs(vol) * (h ** 0.5) * 6.0), 0.05, 0.95)

        items.append({
            "horizon": int(h),
            "prediction": round(pred_h, 2),
            "range_low": round(range_low, 2),
            "range_high": round(range_high, 2),
            "change_pct": round(change_pct, 2),
            "confidence": round(conf, 2),
        })

    payload = {
        "symbol": symbol,
        "timeframe": tf,
        "last_close": round(last_close, 2),
        "as_of": last_date_key,
        "horizons": items,
        "source": "stooq",
        "cache": {"ttl_sec": FORECAST_CACHE_TTL_SEC},
    }

    cache_set(_forecast_cache, cache_key, payload)
    return payload


@app.get("/backtest/{symbol}")
def backtest(symbol: str, timeframe: str = "daily", force: bool = False):
    symbol = (symbol or "").upper().strip()
    if not symbol.isalnum():
        raise HTTPException(status_code=400, detail="Symbol must be letters/numbers only")

    tf = normalize_timeframe(timeframe)

    stock_df = get_symbol_df(symbol, tf)
    last_date = stock_df["Date"].iloc[-1]
    last_date_key = last_date.strftime("%Y-%m-%d") if hasattr(last_date, "strftime") else str(last_date)

    day_bucket = _date_key_today_utc()
    cache_key = f"bt:{symbol}:{tf}:{day_bucket}:{last_date_key}"

    if not force:
        cached = cache_get(_backtest_cache, cache_key, BACKTEST_CACHE_TTL_SEC)
        if cached is not None:
            return cached

    spy_df = get_symbol_df("SPY", tf)
    qqq_df = get_symbol_df("QQQ", tf)

    if len(stock_df) < 180 or len(spy_df) < 180 or len(qqq_df) < 180:
        raise HTTPException(status_code=400, detail="Not enough history to backtest")

    feat = make_features_with_market(stock_df, spy_df, qqq_df)
    feat = feat.tail(900).reset_index(drop=True)

    feature_cols = get_feature_cols()

    params = {"n_estimators": 140, "max_depth": 12, "min_samples_leaf": 2, "max_features": "sqrt"}

    if ENABLE_TUNING:
        tune_key = f"tune:{symbol}:{tf}:{last_date_key}"
        tuned = cache_get(_tune_cache, tune_key, TUNE_CACHE_TTL_SEC)
        if tuned is None:
            tuned = _tune_params_for_symbol(feat, feature_cols)
            cache_set(_tune_cache, tune_key, tuned)
        if isinstance(tuned, dict) and isinstance(tuned.get("params"), dict):
            params = tuned["params"]

    bt = _walk_forward_backtest(
        feat=feat,
        feature_cols=feature_cols,
        target_col="target_next_close",
        params=params,
        max_test_points=50,
        retrain_every=6,
    )

    payload = {
        "symbol": symbol,
        "timeframe": tf,
        "as_of": last_date_key,
        "day_bucket": day_bucket,
        "ok": bool(bt.get("ok")),
        "metrics": bt,
        "params": params,
        "cache": {"ttl_sec": BACKTEST_CACHE_TTL_SEC, "hit": False, "forced": bool(force)},
    }

    cache_set(_backtest_cache, cache_key, payload)
    return payload


# ----------------------------
# News helpers
# ----------------------------
def _mk_id(url: str, title: str) -> str:
    raw = (url or "") + "|" + (title or "")
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:12]

def _fmt_time(s: Optional[str]) -> str:
    if not s:
        return ""
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        return dt.strftime("%b %d, %Y %H:%M UTC")
    except Exception:
        return s

@app.get("/news")
def news(mode: str = "market", symbol: Optional[str] = None, limit: int = 6):
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

    # Placeholder
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

        payload = {"mode": mode, "symbol": sym if sym else None, "items": items, "source": "placeholder"}
        cache_set(_news_cache, cache_key, payload)
        return payload

    # Live Marketaux
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

    payload = {"mode": mode, "symbol": sym if sym else None, "items": items, "source": "marketaux"}
    cache_set(_news_cache, cache_key, payload)
    return payload


# ----------------------------
# Symbols: S&P 500 (free source)
# ----------------------------
def _fetch_sp500_from_free_csv() -> list[dict[str, Any]]:
    urls = [
        "https://raw.githubusercontent.com/datasets/s-and-p-500-companies/master/data/constituents.csv",
        "https://datahub.io/core/s-and-p-500-companies/r/constituents.csv",
        "https://raw.fastgit.org/datasets/s-and-p-500-companies/master/data/constituents.csv",
    ]

    last_err = None
    text = None

    headers = {
        "User-Agent": "stock-predictor/1.0 (+https://example.com)",
        "Accept": "text/csv,*/*;q=0.9",
    }

    for url in urls:
        try:
            r = requests.get(url, timeout=25, headers=headers)
            r.raise_for_status()
            if r.text and len(r.text) > 2000 and "Symbol" in r.text and "," in r.text:
                text = r.text
                break
        except Exception as e:
            last_err = f"{type(e).__name__}: {e}"
            continue

    if text is None:
        raise RuntimeError(f"SP500 CSV fetch failed. Last error: {last_err}")

    df = pd.read_csv(StringIO(text))

    cols = {str(c).strip().lower(): c for c in df.columns}
    sym_col = cols.get("symbol")
    name_col = cols.get("name") or cols.get("security")
    sector_col = cols.get("sector") or cols.get("gics sector")

    if not sym_col or not name_col:
        raise RuntimeError(f"Unexpected CSV schema for S&P 500 constituents: {list(df.columns)}")

    out: list[dict[str, Any]] = []
    for _, row in df.iterrows():
        sym = str(row[sym_col]).strip().upper()
        if not sym:
            continue
        sym_alt = sym.replace(".", "-")  # BRK.B -> BRK-B
        name = str(row[name_col]).strip()
        sector = str(row[sector_col]).strip() if sector_col else ""

        out.append({
            "symbol": sym,
            "symbol_alt": sym_alt if sym_alt != sym else None,
            "name": name,
            "sector": sector,
        })

    seen = set()
    dedup = []
    for it in out:
        if it["symbol"] in seen:
            continue
        seen.add(it["symbol"])
        dedup.append(it)

    if len(dedup) < 400:
        raise RuntimeError(f"SP500 list too small ({len(dedup)}). Source likely blocked/corrupt.")

    return dedup

@app.get("/symbols/sp500")
def symbols_sp500(limit: int = 2000, force_refresh: bool = False):
    cache_key = "sp500:v2"

    if not force_refresh:
        cached_any = _symbols_cache.get(cache_key)
        if cached_any is not None:
            ts, val = cached_any
            cached_source = (val.get("source") if isinstance(val, dict) else None)
            ttl = 60 if cached_source == "fallback" else SYMBOLS_CACHE_TTL_SEC
            if time.time() - ts <= ttl:
                return val
            else:
                try:
                    del _symbols_cache[cache_key]
                except Exception:
                    pass

    fetch_error = None
    try:
        items = _fetch_sp500_from_free_csv()
        source = "free_csv"
    except Exception as e:
        fetch_error = f"{type(e).__name__}: {e}"
        items = [
            {"symbol": "AAPL", "symbol_alt": None, "name": "Apple Inc.", "sector": "Information Technology"},
            {"symbol": "MSFT", "symbol_alt": None, "name": "Microsoft", "sector": "Information Technology"},
            {"symbol": "AMZN", "symbol_alt": None, "name": "Amazon", "sector": "Consumer Discretionary"},
            {"symbol": "NVDA", "symbol_alt": None, "name": "NVIDIA", "sector": "Information Technology"},
            {"symbol": "GOOGL", "symbol_alt": None, "name": "Alphabet (Class A)", "sector": "Communication Services"},
        ]
        source = "fallback"

    limit = int(max(1, min(limit, 2000)))
    items_out = items[:limit]

    payload = {
        "items": items_out,
        "source": source,
        "cache_ttl_sec": SYMBOLS_CACHE_TTL_SEC,
        "count": len(items_out),
        "error": fetch_error if source == "fallback" else None,
    }

    if source == "fallback":
        _symbols_cache[cache_key] = (time.time(), payload)
    else:
        cache_set(_symbols_cache, cache_key, payload)

    return payload


# ----------------------------
# Warmup (reduces first-request latency)
# ----------------------------

ENABLE_WARMUP = os.getenv("ENABLE_WARMUP", "1") == "1"
WARMUP_SYMBOLS = os.getenv("WARMUP_SYMBOLS", "SPY,QQQ,AAPL")
WARMUP_WEEKLY = os.getenv("WARMUP_WEEKLY", "1") == "1"
# Optional: also warm model/prediction caches (slower startup, much faster first click)
WARMUP_PREDICT = os.getenv("WARMUP_PREDICT", "0") == "1"
# Comma-separated list: rf,torch (defaults to DEFAULT_MODEL_TYPE)
WARMUP_MODEL_TYPES = os.getenv("WARMUP_MODEL_TYPES", "").strip()
# Limit how many symbols we actually run predict on (keep startup reasonable)
WARMUP_PREDICT_MAX_SYMBOLS = int(os.getenv("WARMUP_PREDICT_MAX_SYMBOLS", "2"))


@app.on_event("startup")
def _startup_warmup() -> None:
    """Pre-fetch common datasets so the first user click is fast.

    This warms the in-memory data cache used by Stooq downloads.
    """
    if not ENABLE_WARMUP:
        return

    t0 = time.time()

    # Warm daily always; optionally warm weekly too
    tfs = ["daily", "weekly"] if WARMUP_WEEKLY else ["daily"]

    # Normalize symbols
    syms = [s.strip().upper() for s in WARMUP_SYMBOLS.split(",") if s.strip()]
    if not syms:
        syms = ["SPY", "QQQ", "AAPL"]

    warmed = 0

    # 1) Warm market ETFs + a default ticker into _data_cache
    for tf in tfs:
        for sym in syms:
            try:
                # get_symbol_df() calls fetch_stooq_ohlcv() which populates _data_cache
                _ = get_symbol_df(sym, tf)
                warmed += 1
            except Exception:
                continue

    # 2) Try to warm the S&P 500 symbol list cache (so the dropdown loads instantly)
    try:
        items = _fetch_sp500_from_free_csv()
        payload = {
            "items": items[:2000],
            "source": "free_csv",
            "cache_ttl_sec": SYMBOLS_CACHE_TTL_SEC,
            "count": int(min(len(items), 2000)),
            "error": None,
        }
        cache_set(_symbols_cache, "sp500:v2", payload)
    except Exception:
        # If blocked, we'll fall back to the existing runtime fallback behavior
        pass

    # 3) Optionally warm prediction/model caches (so first Predict click is fast)
    if WARMUP_PREDICT:
        # Decide model types to warm
        if WARMUP_MODEL_TYPES:
            model_types = [m.strip().lower() for m in WARMUP_MODEL_TYPES.split(",") if m.strip()]
        else:
            model_types = [DEFAULT_MODEL_TYPE]

        # Respect torch availability
        model_types = [m for m in model_types if m in ("rf", "torch")]
        if not TORCH_AVAILABLE:
            model_types = [m for m in model_types if m != "torch"]

        # Only warm a small number of non-market symbols (SPY/QQQ are already warmed as data)
        # We prefer warming AAPL first if present.
        warm_syms = [s for s in syms if s not in ("SPY", "QQQ")]
        if "AAPL" in syms and "AAPL" not in warm_syms:
            warm_syms = ["AAPL"] + warm_syms
        warm_syms = warm_syms[:max(0, WARMUP_PREDICT_MAX_SYMBOLS)]

        pred_warmed = 0
        for tf in tfs:
            for sym in warm_syms:
                for m in model_types:
                    try:
                        _ = predict(PredictRequest(symbol=sym, timeframe=tf, model=m))
                        # also warm a small forecast cache since frontend calls it
                        _ = forecast(ForecastRequest(symbol=sym, timeframe=tf, horizons=None))
                        pred_warmed += 1
                    except Exception:
                        continue

    dt = time.time() - t0
    print(f"[warmup] ENABLE_WARMUP=1 warmed_data={warmed} tf={tfs} symbols={syms} warmup_predict={int(WARMUP_PREDICT)} in {dt:.2f}s")
