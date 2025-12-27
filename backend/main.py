from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import pandas as pd
import numpy as np
import requests
from io import StringIO
from sklearn.ensemble import RandomForestRegressor

app = FastAPI(title="Stock Predictor API")

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


class PredictRequest(BaseModel):
    symbol: str

def fetch_stooq_daily(symbol: str) -> pd.DataFrame:
    """
    Stooq daily CSV endpoint. No API key.
    Returns columns: Date, Open, High, Low, Close, Volume
    """
    s = symbol.lower().strip()
    # Stooq uses .us for US tickers in many cases (e.g., aapl.us)
    url = f"https://stooq.com/q/d/l/?s={s}.us&i=d"

    r = requests.get(url, timeout=20)
    if r.status_code != 200 or len(r.text) < 50:
        raise HTTPException(status_code=404, detail="Could not download data for that symbol")

    df = pd.read_csv(StringIO(r.text))
    if "Date" not in df.columns or "Close" not in df.columns:
        raise HTTPException(status_code=400, detail="Unexpected data format from data provider")

    df["Date"] = pd.to_datetime(df["Date"])
    df = df.sort_values("Date").reset_index(drop=True)

    # Remove rows with missing values (sometimes there are)
    df = df.dropna(subset=["Close", "Open", "High", "Low", "Volume"])
    return df

def make_features(df: pd.DataFrame) -> pd.DataFrame:
    """
    Feature engineering for daily forecasting.
    We’ll predict next day's close from today’s indicators.
    """
    out = df.copy()

    out["ret_1"] = out["Close"].pct_change(1)
    out["ret_5"] = out["Close"].pct_change(5)
    out["ma_5"] = out["Close"].rolling(5).mean()
    out["ma_10"] = out["Close"].rolling(10).mean()
    out["vol_10"] = out["Close"].rolling(10).std()
    out["volume_ma_10"] = out["Volume"].rolling(10).mean()

    # Target: next day's close
    out["target_next_close"] = out["Close"].shift(-1)

    out = out.dropna().reset_index(drop=True)
    return out

@app.get("/health")
def health():
    return {"ok": True}

@app.post("/predict")
def predict(req: PredictRequest):
    symbol = req.symbol.upper().strip()
    if not symbol.isalnum():
        raise HTTPException(status_code=400, detail="Symbol must be letters/numbers only (e.g., AAPL)")

    df = fetch_stooq_daily(symbol)
    if len(df) < 120:
        raise HTTPException(status_code=400, detail="Not enough history to model this symbol")

    feat = make_features(df)

    feature_cols = ["ret_1", "ret_5", "ma_5", "ma_10", "vol_10", "volume_ma_10"]
    X = feat[feature_cols].values
    y = feat["target_next_close"].values

    # Simple, robust baseline model
    model = RandomForestRegressor(
        n_estimators=300,
        random_state=42,
        n_jobs=-1
    )
    model.fit(X, y)

    # Predict next close using latest available row
    latest = feat.iloc[-1]
    x_latest = latest[feature_cols].values.reshape(1, -1)
    pred_next_close = float(model.predict(x_latest)[0])

    # Range estimate based on recent volatility
    recent_vol = float(df["Close"].pct_change().rolling(20).std().dropna().iloc[-1])
    last_close = float(df["Close"].iloc[-1])
    # 1-sigma style band
    low = pred_next_close * (1 - recent_vol)
    high = pred_next_close * (1 + recent_vol)

    # A simple confidence proxy: lower vol => higher confidence
    confidence = float(np.clip(1 - (recent_vol * 5), 0.05, 0.9))

    return {
        "symbol": symbol,
        "last_close": round(last_close, 2),
        "prediction": round(pred_next_close, 2),
        "range_low": round(low, 2),
        "range_high": round(high, 2),
        "confidence": round(confidence, 2),
        "data_points": int(len(df)),
        "source": "stooq"
    }

@app.get("/history/{symbol}")
def history(symbol: str, days: int = 200, include_prediction: bool = False):
    symbol = symbol.upper().strip()
    if not symbol.isalnum():
        raise HTTPException(status_code=400, detail="Symbol must be letters/numbers only")

    df = fetch_stooq_daily(symbol)
    if len(df) < 30:
        raise HTTPException(status_code=400, detail="Not enough history")

    df = df.tail(days).copy()

    points = [
        {"date": d.strftime("%Y-%m-%d"), "close": float(c)}
        for d, c in zip(df["Date"], df["Close"])
    ]

    return {
        "symbol": symbol,
        "points": points
    }

