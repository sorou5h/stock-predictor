"use client";

export default function RiskMeter({ vol }: { vol: number }) {
  // vol is decimal (e.g. 0.018 = 1.8%)
  const pct = Math.max(0, Math.min(1, vol * 25)); // scale into 0..1
  let label = "Low";
  let hint = "Relatively stable price action.";
  let tone =
    "border-emerald-700 bg-emerald-950/30 text-emerald-200";

  if (pct > 0.45) {
    label = "Medium";
    hint = "Normal volatility — expect swings.";
    tone = "border-amber-700 bg-amber-950/30 text-amber-200";
  }
  if (pct > 0.75) {
    label = "High";
    hint = "High volatility — larger moves likely.";
    tone = "border-red-700 bg-red-950/30 text-red-200";
  }

  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-950 p-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-xs text-zinc-500">Risk Meter</div>
          <div className="mt-1 text-sm font-medium text-zinc-200">{label} risk</div>
          <div className="mt-1 text-xs text-zinc-500">{hint}</div>
        </div>
        <div className={`shrink-0 rounded-xl border px-3 py-2 text-xs ${tone}`}>
          Vol {(vol * 100).toFixed(2)}%
        </div>
      </div>

      <div className="mt-3 h-2 w-full rounded-full bg-zinc-900 overflow-hidden">
        <div
          className="h-full bg-zinc-100/80"
          style={{ width: `${Math.round(pct * 100)}%` }}
        />
      </div>

      <div className="mt-2 flex justify-between text-[11px] text-zinc-500">
        <span>Low</span>
        <span>High</span>
      </div>
    </div>
  );
}