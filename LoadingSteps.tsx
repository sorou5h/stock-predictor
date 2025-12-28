"use client";

export default function LoadingSteps({ phase }: { phase: number }) {
  const steps = [
    "Fetching market data…",
    "Analyzing past price action…",
    "Comparing against market (SPY/QQQ)…",
    "Training & validating model…",
    "Predicting the next outcome…",
  ];

  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-950 p-4">
      <div className="text-xs text-zinc-500">Working</div>
      <div className="mt-1 text-sm font-medium text-zinc-200">
        {steps[Math.min(phase, steps.length - 1)]}
      </div>

      <div className="mt-3 space-y-2">
        {steps.map((s, i) => (
          <div key={i} className="flex items-center gap-2 text-xs">
            <div
              className={`h-2 w-2 rounded-full ${
                i <= phase ? "bg-zinc-100" : "bg-zinc-700"
              }`}
            />
            <span className={i <= phase ? "text-zinc-200" : "text-zinc-500"}>
              {s}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}