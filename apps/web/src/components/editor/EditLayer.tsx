import { CARD_ANCHORS, NO_BEST_MOVE, TEXT_CAPS, type Card, type Moment } from '@als/schema';
import { MoveCard, cardRect, moveNumbers, type CardField } from '@als/composition';
import { useLayoutEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import { updateMoment } from '../../editor/doc.ts';
import { useEditor, useEditorStore } from '../../editor/context.tsx';
import { ClassificationPicker } from './ClassificationPicker.tsx';
import { EditableText } from './EditableText.tsx';

const PLACEHOLDERS: Record<CardField, string> = {
  moveLabel: 'What they did',
  explanation: 'Why it earned this rating',
  bestMove: 'What they should have done',
  motif: 'Motif',
};

/** Composition pixels within which a dragged card snaps back to a corner anchor. */
const ANCHOR_SNAP_PX = 24;

type Corner = Exclude<Card['anchor'], 'custom'>;

export interface EditLayerProps {
  moment: Moment;
  /** Composition size. */
  width: number;
  height: number;
  /** Screen pixels per composition pixel. */
  scale: number;
}

/**
 * The card, editable in place, drawn exactly over the card the composition
 * renders: same component, same placement. Lives outside the composition, so
 * the render path never sees it.
 */
export function EditLayer({ moment, width, height, scale }: EditLayerProps) {
  const store = useEditorStore();
  const theme = useEditor((s) => s.theme);
  const characters = useEditor((s) => s.doc.characters);
  const moments = useEditor((s) => s.doc.moments);
  const moveNumber = useMemo(() => moveNumbers(moments, characters).get(moment.id), [moments, characters, moment.id]);
  const focusRequest = useEditor((s) => s.focusRequest);
  const cardEl = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const [picking, setPicking] = useState(false);
  const actorName = characters.find((c) => c.id === moment.actorId)?.name;
  const frame = { width, height };

  // Card bounds in composition pixels, for the toolbar and drags.
  useLayoutEffect(() => {
    const el = cardEl.current;
    if (!el) return;
    const measure = () => setBox({ left: el.offsetLeft, top: el.offsetTop, width: el.offsetWidth, height: el.offsetHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [moment.card, moment.id]);

  const setField = (field: CardField, value: string) =>
    store.getState().edit(
      (d) => updateMoment(d, moment.id, (field === 'bestMove' || field === 'motif') && value === '' ? { [field]: undefined } : { [field]: value }),
      { coalesce: `${moment.id}.${field}` },
    );

  const setCard = (card: Card) => store.getState().gesture((d) => updateMoment(d, moment.id, { card }));

  /** Drag to move: the card becomes custom-placed, or snaps back to a corner. */
  const onDragStart = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !cardEl.current) return;
    e.preventDefault();
    const el = cardEl.current;
    el.setPointerCapture(e.pointerId);
    const start = { x: e.clientX, y: e.clientY, left: el.offsetLeft, top: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight };
    store.getState().beginGesture();
    // A badge beside the card stays in the frame too.
    const badgeRoom =
      theme.card.layout === 'headline' ? (theme.card.badgeSize + theme.card.badgeGap) * cardRect(moment.card, frame, theme).unit : 0;
    const move = (ev: globalThis.PointerEvent) => {
      const left = clamp(start.left + (ev.clientX - start.x) / scale, badgeRoom, width - start.w);
      const top = clamp(start.top + (ev.clientY - start.y) / scale, 0, height - start.h);
      setCard(placeCard(left, top, start.w, start.h, moment.card.scale));
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      store.getState().endGesture();
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };

  /** Corner handle: scales the card, growing away from its anchor. */
  const onResizeStart = (e: PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const grows = growDirection(moment.card.anchor);
    const start = { x: e.clientX, scale: moment.card.scale, w: cardEl.current!.offsetWidth };
    store.getState().beginGesture();
    const move = (ev: globalThis.PointerEvent) => {
      const dx = ((ev.clientX - start.x) / scale) * grows;
      const next = Math.round(clamp(start.scale * ((start.w + dx) / start.w), 0.5, 2) * 100) / 100;
      setCard({ ...moment.card, scale: next });
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      store.getState().endGesture();
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
  };

  function placeCard(left: number, top: number, w: number, h: number, cardScale: number): Card {
    // Snap back to a corner if the card is dropped where that anchor would put it.
    for (const anchor of CARD_ANCHORS) {
      if (anchor === 'custom') continue;
      const r = cardRect({ anchor, scale: cardScale }, frame, theme);
      const cornerLeft = r.left ?? width - (r.right ?? 0) - w;
      const cornerTop = r.top ?? height - (r.bottom ?? 0) - h;
      if (Math.abs(cornerLeft - left) < ANCHOR_SNAP_PX && Math.abs(cornerTop - top) < ANCHOR_SNAP_PX) {
        return { anchor, scale: cardScale };
      }
    }
    return { anchor: 'custom', x: round4(left / width), y: round4(top / height), scale: cardScale };
  }

  const focusFor = (field: CardField) =>
    focusRequest && focusRequest.id === moment.id && focusRequest.field === field ? focusRequest.n : undefined;
  const handle = handleCorner(moment.card.anchor, -7 / scale);
  // Diagonal resize cursor matching the handle's corner.
  const nwse = (handle.right !== undefined) === (handle.bottom !== undefined);

  return (
    <div className="pointer-events-none absolute inset-0 z-10 overflow-hidden" data-testid="edit-layer">
      <div style={{ width, height, transform: `scale(${scale})`, transformOrigin: '0 0', position: 'relative' }}>
        <MoveCard
          moment={moment}
          actorName={actorName}
          moveNumber={moveNumber}
          theme={theme}
          frame={frame}
          visibility={1}
          enter={1}
          editing={{
            showEmptyFields: true,
            unclamped: true,
            rootRef: cardEl,
            rootProps: {
              onPointerDown: onDragStart,
              className: 'als-edit-card',
              style: { pointerEvents: 'auto', cursor: 'move', outline: `${2 / scale}px solid rgba(125, 211, 252, 0.7)`, outlineOffset: 4 / scale },
            },
            badge: (badge) => (
              <button
                type="button"
                title="Change rating (1–0)"
                data-testid="badge-button"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => setPicking((p) => !p)}
                style={{ all: 'unset', cursor: 'pointer', display: 'block', borderRadius: '50%' }}
              >
                {badge}
              </button>
            ),
            field: (name, value) => (
              <EditableText
                field={name}
                value={value}
                placeholder={PLACEHOLDERS[name]}
                singleLine={name === 'moveLabel' || name === 'motif'}
                onChange={(v) => setField(name, v)}
                focusSignal={focusFor(name)}
              />
            ),
            children: (
              <div
                data-testid="resize-handle"
                title="Drag to resize"
                onPointerDown={onResizeStart}
                style={{
                  position: 'absolute',
                  ...handle,
                  width: 18 / scale,
                  height: 18 / scale,
                  borderRadius: 4 / scale,
                  background: '#7dd3fc',
                  cursor: nwse ? 'nwse-resize' : 'nesw-resize',
                }}
              />
            ),
          }}
        />
      </div>

      {box && (
        <Toolbar
          moment={moment}
          left={box.left * scale}
          top={box.top * scale}
          bottom={(box.top + box.height) * scale}
          layerHeight={height * scale}
          picking={picking}
          onPick={(c) => {
            store.getState().edit((d) => updateMoment(d, moment.id, { classification: c }));
            setPicking(false);
          }}
          onTogglePicker={() => setPicking((p) => !p)}
        />
      )}
    </div>
  );
}

function Toolbar(props: {
  moment: Moment;
  left: number;
  top: number;
  bottom: number;
  layerHeight: number;
  picking: boolean;
  onPick: Parameters<typeof ClassificationPicker>[0]['onPick'];
  onTogglePicker: () => void;
}) {
  const { moment, picking } = props;
  const theme = useEditor((s) => s.theme);
  const store = useEditorStore();
  const style = theme.classifications[moment.classification];
  // Above the card when there is room, otherwise below it.
  const above = props.top > 44;
  const counters = (Object.keys(TEXT_CAPS) as CardField[])
    .filter((f) => f !== 'bestMove' || !NO_BEST_MOVE.has(moment.classification))
    .map((f) => ({ f, n: (moment[f] ?? '').length, cap: TEXT_CAPS[f] }));
  const LABEL: Record<CardField, string> = { moveLabel: 'Label', explanation: 'Breakdown', bestMove: 'Best', motif: 'Motif' };

  const picker = picking && (
    <div className="w-64 rounded-md border border-neutral-700 bg-neutral-950/95 p-1.5 shadow-lg" data-testid="rating-picker">
      <ClassificationPicker theme={theme} value={moment.classification} onPick={props.onPick} />
    </div>
  );

  return (
    <div
      className="pointer-events-auto absolute flex flex-col gap-1"
      style={{ left: Math.max(4, props.left), ...(above ? { bottom: props.layerHeight - props.top + 10 } : { top: props.bottom + 10 }) }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {above && picker}
      <div className="flex items-center gap-2 rounded-md border border-neutral-700 bg-neutral-950/95 px-2 py-1 text-[11px] text-neutral-300 shadow-lg">
        <button type="button" onClick={props.onTogglePicker} className="font-semibold" style={{ color: style.color }}>
          {style.label} ▾
        </button>
        <span className="text-neutral-700">|</span>
        {counters.map(({ f, n, cap }) => (
          <span key={f} className={`tabular-nums ${n > cap ? 'font-semibold text-red-400' : ''}`} data-testid={`counter-${f}`}>
            {LABEL[f]} {n}/{cap}
          </span>
        ))}
        <span className="text-neutral-700">|</span>
        <span className="tabular-nums">
          Hold {moment.holdSec.toFixed(1)} s{moment.holdLocked ? '' : ' auto'}
        </span>
        <span className="text-neutral-700">|</span>
        <button
          type="button"
          onClick={() =>
            store.getState().edit((d) => updateMoment(d, moment.id, { status: moment.status === 'approved' ? 'draft' : 'approved' }))
          }
          className={moment.status === 'approved' ? 'text-emerald-400' : 'text-neutral-300 hover:text-white'}
          title="Approve (A)"
        >
          {moment.status === 'approved' ? '✓ Approved' : 'Approve'}
        </button>
      </div>
      {!above && picker}
    </div>
  );
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));
const round4 = (v: number) => Math.round(v * 10000) / 10000;

/** +1 when the card grows to the right as it scales, −1 when it grows to the left. */
const growDirection = (anchor: Card['anchor']) => (anchor === 'top-right' || anchor === 'bottom-right' ? -1 : 1);

/** The resize handle sits on the corner away from the card's anchor. */
function handleCorner(anchor: Card['anchor'], offset: number): { left?: number; right?: number; top?: number; bottom?: number } {
  const corner: Corner = anchor === 'custom' ? 'top-left' : anchor;
  return {
    ...(corner.endsWith('left') ? { right: offset } : { left: offset }),
    ...(corner.startsWith('top') ? { bottom: offset } : { top: offset }),
  };
}
