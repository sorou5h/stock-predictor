from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import numpy as np

app = FastAPI(title="Stock Predictor API")

# Allow frontend to call backend during development
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class PredictRequest(BaseModel):
    symbol: str

@app.get("/health")
def health():
    return {"ok": True}

@app.post("/predict")
def predict(req: PredictRequest):
    """
    MVP prediction:
    For now, return a mock prediction so the website is fully wired.
    Next step: replace this with real market data + model.
    """
    # A simple dummy forecast (replace later)
    base = 100.0
    pred = base + float(np.random.normal(0, 1.5))
    low = pred - 2.5
    high = pred + 2.5

    return {
        "symbol": req.symbol.upper(),
        "prediction": round(pred, 2),
        "range_low": round(low, 2),
        "range_high": round(high, 2),
        "confidence": 0.55
    }
