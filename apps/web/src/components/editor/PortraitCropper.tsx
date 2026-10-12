import { useEffect, useRef, useState, type PointerEvent } from 'react';

/** A square on the frame: top-left corner as fractions of width and height, side as a fraction of height. */
export interface CropSquare {
  x: number;
  y: number;
  size: number;
}

const MIN_SIZE = 0.08;

/**
 * Drawn over the stage while a portrait is being picked: drag the square onto a
 * face, drag its corner to resize, then Use (Enter) or Cancel (Esc).
 */
export function PortraitCropper({
  name,
  aspect,
  busy,
  onUse,
  onCancel,
}: {
  name: string;
  /** Frame width over height. */
  aspect: number;
  busy: boolean;
  onUse: (square: CropSquare) => void;
  onCancel: () => void;
}) {
  const [square, setSquare] = useState<CropSquare>({ x: 0.5 - 0.2 / aspect, y: 0.25, size: 0.4 });
  const area = useRef<HTMLDivElement>(null);

  // Keeps the square inside the frame.
  const fit = (s: CropSquare): CropSquare => {
    const size = Math.min(Math.max(s.size, MIN_SIZE), 1, aspect);
    const width = size / aspect;
    return { size, x: Math.min(Math.max(s.x, 0), 1 - width), y: Math.min(Math.max(s.y, 0), 1 - size) };
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
      else if (e.key === 'Enter' && !busy) onUse(square);
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onUse, onCancel, busy, square]);

  const drag = (e: PointerEvent<HTMLElement>, mode: 'move' | 'resize') => {
    e.stopPropagation();
    e.preventDefault();
    const rect = area.current!.getBoundingClientRect();
    const start = { px: e.clientX, py: e.clientY, ...square };
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const move = (ev: globalThis.PointerEvent) => {
      const dx = (ev.clientX - start.px) / rect.width;
      const dy = (ev.clientY - start.py) / rect.height;
      setSquare(
        fit(
          mode === 'move'
            ? { ...start, x: start.x + dx, y: start.y + dy }
            : { ...start, size: start.size + Math.max(dx * aspect, dy) },
        ),
      );
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };

  return (
    <div ref={area} className="absolute inset-0 z-30 cursor-crosshair overflow-hidden" data-testid="portrait-cropper">
      <div
        onPointerDown={(e) => drag(e, 'move')}
        className="absolute cursor-move rounded-sm border-2 border-white"
        style={{
          left: `${square.x * 100}%`,
          top: `${square.y * 100}%`,
          width: `${(square.size / aspect) * 100}%`,
          height: `${square.size * 100}%`,
          boxShadow: '0 0 0 9999px rgba(0, 0, 0, 0.6)',
        }}
        data-testid="crop-square"
      >
        <span
          onPointerDown={(e) => drag(e, 'resize')}
          className="absolute -right-2 -bottom-2 size-4 cursor-nwse-resize rounded-sm border-2 border-neutral-900 bg-white"
          data-testid="crop-handle"
        />
      </div>
      <div className="absolute inset-x-0 bottom-3 flex items-center justify-center gap-2 text-xs">
        <span className="rounded bg-neutral-950/80 px-2 py-1 text-neutral-200">Portrait for {name || 'this character'}: drag onto the face</span>
        <button
          type="button"
          disabled={busy}
          onClick={() => onUse(square)}
          className="rounded bg-sky-600 px-3 py-1 font-medium text-white hover:bg-sky-500 disabled:opacity-50"
          data-testid="crop-use"
        >
          {busy ? 'Cropping…' : 'Use'}
        </button>
        <button type="button" onClick={onCancel} className="rounded bg-neutral-800 px-3 py-1 text-neutral-200 hover:bg-neutral-700">
          Cancel
        </button>
      </div>
    </div>
  );
}
