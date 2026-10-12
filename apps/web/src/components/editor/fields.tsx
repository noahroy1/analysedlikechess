import { useState, type ReactNode } from 'react';

export function Field({ label, count, children }: { label: string; count?: [number, number]; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 flex justify-between text-[11px] font-medium tracking-wide text-neutral-400 uppercase">
        {label}
        {count && <span className={`tabular-nums normal-case ${count[0] > count[1] ? 'text-red-400' : 'text-neutral-500'}`}>{count[0]}/{count[1]}</span>}
      </span>
      {children}
    </label>
  );
}

/** A seconds field that commits on Enter or blur, snapped to 1/fps. */
export function SecondsInput({ value, fps, min = 0, onCommit }: { value: number; fps: number; min?: number; onCommit: (sec: number) => void }) {
  // What the user is typing; null shows the current value.
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    const sec = Number(draft);
    if (draft !== null && Number.isFinite(sec) && sec >= min) onCommit(Math.round(sec * fps) / fps);
    setDraft(null);
  };
  return (
    <input
      value={draft ?? value.toFixed(2)}
      inputMode="decimal"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
      className="input tabular-nums"
    />
  );
}
