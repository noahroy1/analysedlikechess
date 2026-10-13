import { evalLeader, formatEval, formatEvalSigned, type Character, type Moment, type Theme } from '@als/schema';
import type { CSSProperties } from 'react';
import type { FrameSize } from './card.ts';
import type { EvalBarState } from './eval-bar.ts';
import { evalBarLayout, type Rect } from './layout.ts';

type BarStyle = NonNullable<Theme['evalBar']>;

export interface BarPlayer {
  name: string;
  side: 'white' | 'black';
  portrait?: string;
}

/** The character shown for each side: whoever on that side makes the most moves, the first listed on a tie. */
export function barPlayers(
  characters: readonly Character[],
  moments: readonly Pick<Moment, 'actorId'>[],
  portraits: Record<string, string> = {},
): Record<'white' | 'black', BarPlayer | undefined> {
  const pick = (side: 'white' | 'black'): BarPlayer | undefined => {
    const onSide = characters.filter((c) => c.side === side);
    const moves = (c: Character) => moments.filter((m) => m.actorId === c.id).length;
    const best = onSide.reduce<Character | undefined>((a, c) => (a && moves(a) >= moves(c) ? a : c), undefined);
    return best && { name: best.name, side, ...(portraits[best.id] ? { portrait: portraits[best.id] } : {}) };
  };
  return { white: pick('white'), black: pick('black') };
}

export interface EvalBarProps {
  state: EvalBarState;
  players: Record<'white' | 'black', BarPlayer | undefined>;
  style: BarStyle;
  fontFamily: string;
  frame: FrameSize;
  /** The project's bar size; every part shrinks with it. */
  scale?: number;
}

// Text is placed by its baseline, as measured: Arial's baseline sits 0.8465 em
// below the top of a line-height 1 box.
const BASELINE = 0.8465;

/** Black's player at the top, White's at the bottom, and the bar between them filling from White's end. */
export function EvalBar({ state, players, style, fontFamily, frame, scale = 1 }: EvalBarProps) {
  const layout = evalBarLayout(style, frame, scale);
  const { k, bar } = layout;
  const px = (n: number) => n * k;
  const fw = px(style.frameWidth);
  const innerHeight = bar.bottom - bar.top - 2 * fw;
  const leader = evalLeader(state.label);
  // The label's baseline sits 11 px inside the leader's end of the bar.
  const labelInset = 11 - (1 - BASELINE) * style.labelSize;

  return (
    <div
      style={{ position: 'absolute', inset: 0, fontFamily, pointerEvents: 'none' }}
      data-testid="eval-bar"
      data-fill={state.fill.toFixed(4)}
      data-label={formatEvalSigned(state.label)}
    >
      <div
        style={{
          position: 'absolute',
          left: bar.left,
          top: bar.top,
          width: bar.right - bar.left,
          height: bar.bottom - bar.top,
          background: style.frameColor,
          borderRadius: px(3),
        }}
      >
        <div style={{ position: 'absolute', inset: fw, background: style.blackColor, overflow: 'hidden' }}>
          <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: innerHeight * state.fill, background: style.whiteColor }} />
          <div
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              [leader === 'white' ? 'bottom' : 'top']: px(labelInset),
              height: px(style.labelSize),
              lineHeight: 1,
              fontSize: px(style.labelSize),
              fontWeight: 700,
              textAlign: 'center',
              color: leader === 'white' ? style.whiteTextColor : style.blackTextColor,
            }}
          >
            {formatEval(state.label)}
          </div>
        </div>
      </div>
      {(['black', 'white'] as const).map((side) => (
        <PlayerTag key={side} player={players[side]} side={side} box={layout.portraits[side]} textLeft={layout.textLeft} style={style} px={px} />
      ))}
    </div>
  );
}

interface PlayerTagProps {
  player: BarPlayer | undefined;
  side: 'white' | 'black';
  /** The portrait with its frame, in frame pixels. */
  box: Rect;
  textLeft: number;
  style: BarStyle;
  /** Bar units to pixels. */
  px: (n: number) => number;
}

function PlayerTag({ player, side, box, textLeft, style, px }: PlayerTagProps) {
  const text = (size: number, baseline: number, color: string, weight: number): CSSProperties => ({
    position: 'absolute',
    left: textLeft,
    top: box.top + px(baseline - BASELINE * size),
    fontSize: px(size),
    lineHeight: 1,
    fontWeight: weight,
    color,
    whiteSpace: 'nowrap',
    textShadow: `0 ${px(1)}px ${px(3)}px rgba(0, 0, 0, 0.6)`,
  });
  const name = player?.name ?? '';
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');

  return (
    <>
      <div
        style={{
          position: 'absolute',
          left: box.left,
          top: box.top,
          width: box.right - box.left,
          height: box.bottom - box.top,
          padding: px(style.frameWidth),
          boxSizing: 'border-box',
          background: style.frameColor,
          borderRadius: px(5),
        }}
      >
        {player?.portrait ? (
          <img src={player.portrait} style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: px(2), display: 'block' }} />
        ) : (
          <div
            style={{
              width: '100%',
              height: '100%',
              borderRadius: px(2),
              background: side === 'white' ? style.whiteColor : style.blackColor,
              color: side === 'white' ? style.whiteTextColor : style.blackTextColor,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: px(style.portraitSize * 0.36),
              fontWeight: 700,
            }}
          >
            {initials}
          </div>
        )}
      </div>
      {player && <div style={text(style.nameSize, 45, style.nameColor, 700)}>{name}</div>}
      <div style={text(style.sideSize, 70, style.sideColor, 400)}>{side === 'white' ? 'White' : 'Black'}</div>
    </>
  );
}
