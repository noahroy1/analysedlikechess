import {
  REVIEW_ROWS,
  evalGraph,
  gameResult,
  reviewAccuracy,
  reviewSummary,
  moveTallies,
  type Character,
  type EvalBar,
  type GameReview as GameReviewData,
  type GraphPoint,
  type Moment,
  type Theme,
} from '@als/schema';
import { Badge } from '@als/theme';
import type { CSSProperties, ReactNode } from 'react';
import { Img } from 'remotion';
import type { FrameSize } from './card.ts';
import { barPlayers } from './EvalBar.tsx';

// chess.com's Game Review screen, measured on media/game-review-screen-ref.png
// (483 × 837, Oct 15, 2026). Every size below is a pixel of that screenshot;
// the panel scales to fit the frame. The screenshot crops the header, so ours
// is 11 px taller with the title centred; everything under it moves down 11.
//
// TODO(open-decision): the panel is a full screen, not an overlay, so it fits
// the frame (on a vertical clip it is about twice its landscape size) rather
// than following the theme unit; it cuts in with no animation, like the creator's holds.

const PANEL_WIDTH = 483;
const PANEL_HEIGHT = 848;
const HEADER = 44;
/** Share of the frame the panel may fill, in each direction. */
const FIT = 0.94;
const SIDE_MARGIN = 16;
const INNER_WIDTH = PANEL_WIDTH - 2 * SIDE_MARGIN;
/** Centres of White's and Black's columns, and of the badges between them. */
const COLUMN = { white: 236.5, black: 383.5 } as const;
const BADGE_X = 310;
/** Arial sets wider than chess.com's font, so these match the screenshot's text by width. */
const LABEL_SIZE = 14;
const COUNT_SIZE = 17;

const COLORS = {
  panel: '#22211e',
  header: '#1d1c1a',
  title: '#dddddd',
  icon: '#8e8e8d',
  text: '#ffffff',
  bubble: '#ffffff',
  bubbleText: '#2b2926',
  graphBlack: '#383632',
  graphWhite: '#ffffff',
  graphMid: 'rgba(128, 128, 128, 0.5)',
  divider: '#393835',
  accuracyWhite: '#ffffff',
  accuracyWhiteText: '#2b2926',
  accuracyBlack: '#2d2c29',
  accuracyBlackText: '#ffffff',
  winner: '#7dad45',
  avatar: '#e3e1df',
  chevron: '#91908f',
};

export interface GameReviewProps {
  review: GameReviewData | undefined;
  moments: readonly Moment[];
  characters: readonly Character[];
  evalBar: EvalBar | undefined;
  portraits: Record<string, string> | undefined;
  theme: Theme;
  frame: FrameSize;
}

/** The closing review: result, the bar's graph, both players with their accuracy, and each side's moves by rating. */
export function GameReview({ review, moments, characters, evalBar, portraits, theme, frame }: GameReviewProps) {
  const s = Math.min((FIT * frame.height) / PANEL_HEIGHT, (FIT * frame.width) / PANEL_WIDTH);
  const px = (n: number) => n * s;
  const players = barPlayers(characters, moments, portraits);
  const result = gameResult(evalBar, moments, characters);
  const tally = moveTallies(moments, characters);
  const summary = review?.summary ?? reviewSummary(result, { white: players.white?.name, black: players.black?.name });
  const font = theme.card.fontFamily;

  /** A line of text centred on (x, y), or left-aligned from x. */
  const text = (x: number, y: number, size: number, style: CSSProperties, content: ReactNode, align: 'left' | 'center' = 'center', width = 140) => (
    <div
      style={{
        position: 'absolute',
        left: px(align === 'center' ? x - width / 2 : x),
        top: px(y - size),
        width: px(width),
        height: px(2 * size),
        lineHeight: `${px(2 * size)}px`,
        fontSize: px(size),
        textAlign: align,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        ...style,
      }}
    >
      {content}
    </div>
  );

  return (
    <div
      data-testid="game-review"
      data-winner={result.winner ?? 'draw'}
      style={{
        position: 'absolute',
        left: (frame.width - px(PANEL_WIDTH)) / 2,
        top: (frame.height - px(PANEL_HEIGHT)) / 2,
        width: px(PANEL_WIDTH),
        height: px(PANEL_HEIGHT),
        background: COLORS.panel,
        borderRadius: px(10),
        overflow: 'hidden',
        boxShadow: `0 ${px(8)}px ${px(40)}px rgba(0, 0, 0, 0.5)`,
        fontFamily: font,
        fontWeight: 700,
        color: COLORS.text,
      }}
    >
      {/* Header: a heart, the title with its icon, and the analysis button. */}
      <div style={{ position: 'absolute', left: 0, top: 0, width: px(PANEL_WIDTH), height: px(HEADER), background: COLORS.header }}>
        <HeartIcon x={px(5)} y={px(HEADER / 2 - 10)} size={px(20)} />
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: px(8) }}>
          <ReviewIcon size={px(25)} color={theme.classifications.best.color} />
          <span style={{ fontSize: px(20), color: COLORS.title, lineHeight: 1 }}>Game Review</span>
        </div>
        <AnalysisIcon x={px(PANEL_WIDTH - 25)} y={px(HEADER / 2 - 10)} size={px(20)} />
      </div>

      {/* The result in a speech bubble. */}
      <div
        data-testid="game-review-summary"
        style={{
          position: 'absolute',
          left: px(SIDE_MARGIN),
          top: px(68),
          width: px(INNER_WIDTH),
          height: px(64),
          boxSizing: 'border-box',
          padding: `0 ${px(16)}px`,
          background: COLORS.bubble,
          borderRadius: px(8),
          display: 'flex',
          alignItems: 'center',
          color: COLORS.bubbleText,
          fontSize: px(16),
          fontWeight: 400,
          lineHeight: 1.33,
        }}
      >
        <span style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{summary}</span>
      </div>

      <Graph points={evalGraph(evalBar, moments, characters)} theme={theme} left={px(SIDE_MARGIN)} top={px(148)} width={px(INNER_WIDTH)} height={px(78)} s={s} />

      {text(SIDE_MARGIN, 295, LABEL_SIZE, {}, 'Players', 'left')}
      {text(SIDE_MARGIN, 353, LABEL_SIZE, {}, 'Accuracy', 'left')}
      {(['white', 'black'] as const).map((side) => {
        const player = players[side];
        const x = COLUMN[side];
        const accuracy = reviewAccuracy(review, side);
        return (
          <div key={side} data-testid={`game-review-${side}`}>
            {text(x, 246, LABEL_SIZE, {}, player?.name ?? (side === 'white' ? 'White' : 'Black'), 'center', 145)}
            <Avatar
              portrait={player?.portrait}
              winner={result.winner === side}
              left={px(x - 32)}
              top={px(263)}
              size={px(64)}
              s={s}
            />
            <div
              data-testid={`game-review-accuracy-${side}`}
              style={{
                position: 'absolute',
                left: px(x - 32),
                top: px(335),
                width: px(64),
                height: px(36),
                borderRadius: px(5),
                background: side === 'white' ? COLORS.accuracyWhite : COLORS.accuracyBlack,
                color: side === 'white' ? COLORS.accuracyWhiteText : COLORS.accuracyBlackText,
                fontSize: px(18),
                lineHeight: `${px(36)}px`,
                textAlign: 'center',
              }}
            >
              {accuracy.toFixed(1)}
            </div>
          </div>
        );
      })}

      <div style={{ position: 'absolute', left: px(SIDE_MARGIN), top: px(387), width: px(INNER_WIDTH), height: Math.max(1, px(1)), background: COLORS.divider }} />

      {REVIEW_ROWS.map((classification, i) => {
        const y = 423 + 40 * i;
        const style = theme.classifications[classification];
        return (
          <div key={classification} data-testid={`game-review-row-${classification}`}>
            {text(SIDE_MARGIN, y, LABEL_SIZE, {}, style.label, 'left')}
            {text(COLUMN.white, y, COUNT_SIZE, { color: style.color }, tally.white[classification], 'center', 60)}
            <div style={{ position: 'absolute', left: px(BADGE_X - 12), top: px(y - 12) }}>
              <Badge badge={style.badge} color={style.color} size={px(24)} fontFamily={font} />
            </div>
            {text(COLUMN.black, y, COUNT_SIZE, { color: style.color }, tally.black[classification], 'center', 60)}
          </div>
        );
      })}

      <svg style={{ position: 'absolute', left: px(COLUMN.white - 10), top: px(820), width: px(20), height: px(12) }} viewBox="0 0 20 12">
        <path d="M2.5 10L10 3l7.5 7" fill="none" stroke={COLORS.chevron} strokeWidth={3.4} strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  );
}

/** White's share across the game, with a dot in its rating's colour at every move. */
function Graph({ points, theme, left, top, width, height, s }: { points: GraphPoint[]; theme: Theme; left: number; top: number; width: number; height: number; s: number }) {
  const r = 4 * s;
  // Points sit a dot's width in from each end, so the first and last dots are whole.
  const x = (i: number) => (points.length < 2 ? width / 2 : r + 1 + (i / (points.length - 1)) * (width - 2 * (r + 1)));
  const y = (fill: number) => (1 - fill) * height;
  const line = points.map((p, i) => `L${x(i).toFixed(2)},${y(p.fill).toFixed(2)}`).join(' ');
  const area = `M0,${height} L0,${y(points[0]!.fill).toFixed(2)} ${line} L${width},${y(points.at(-1)!.fill).toFixed(2)} L${width},${height} Z`;
  const clampY = (v: number) => Math.min(Math.max(v, r + 0.5), height - r - 0.5);

  return (
    <svg
      data-testid="game-review-graph"
      style={{ position: 'absolute', left, top, width, height, borderRadius: 5 * s, overflow: 'hidden' }}
      viewBox={`0 0 ${width} ${height}`}
    >
      <rect x={0} y={0} width={width} height={height} fill={COLORS.graphBlack} />
      <path d={area} fill={COLORS.graphWhite} />
      <rect x={0} y={height / 2 - s} width={width} height={2 * s} fill={COLORS.graphMid} />
      {points.map((p, i) =>
        p.classification ? <circle key={i} cx={x(i)} cy={clampY(y(p.fill))} r={r} fill={theme.classifications[p.classification].color} data-classification={p.classification} /> : null,
      )}
    </svg>
  );
}

/** The cast member's portrait; without one, chess.com's grey pawn. The winner gets a green frame. */
function Avatar({ portrait, winner, left, top, size, s }: { portrait: string | undefined; winner: boolean; left: number; top: number; size: number; s: number }) {
  const border = winner ? 4 * s : 0;
  return (
    <div
      data-winner={winner || undefined}
      style={{
        position: 'absolute',
        left,
        top,
        width: size,
        height: size,
        boxSizing: 'border-box',
        border: border ? `${border}px solid ${COLORS.winner}` : undefined,
        borderRadius: 5 * s,
        overflow: 'hidden',
        background: COLORS.avatar,
      }}
    >
      {portrait ? (
        <Img src={portrait} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
      ) : (
        <svg viewBox="0 0 64 64" style={{ width: '100%', height: '100%', display: 'block' }}>
          <circle cx={32} cy={18} r={7.5} fill="#b3b3ae" />
          <path d="M25.5 27h13l-1.6 3.4c3.4 5.6 5.4 11.4 6.6 17.6h-23c1.2-6.2 3.2-12 6.6-17.6z" fill="#b3b3ae" />
          <path d="M17 52.5c0-3.6 3-5.5 7-5.5h16c4 0 7 1.9 7 5.5V55H17z" fill="#7d7c7a" />
          <path d="M32 27h6.5l-1.6 3.4c3.4 5.6 5.4 11.4 6.6 17.6H32z" fill="#9a9995" />
        </svg>
      )}
    </div>
  );
}

const iconBox = (x: number, y: number, size: number): CSSProperties => ({ position: 'absolute', left: x, top: y, width: size, height: size });

function HeartIcon({ x, y, size }: { x: number; y: number; size: number }) {
  return (
    <svg style={iconBox(x, y, size)} viewBox="0 0 24 24">
      <path
        d="M12 20.5s-8-4.9-8-10.6C4 7 6.1 5 8.6 5c1.5 0 2.7.7 3.4 1.9C12.7 5.7 13.9 5 15.4 5 17.9 5 20 7 20 9.9c0 5.7-8 10.6-8 10.6z"
        fill="none"
        stroke={COLORS.icon}
        strokeWidth={2.2}
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** A magnifier over a star in the best-move colour. */
function ReviewIcon({ size, color }: { size: number; color: string }) {
  return (
    <svg style={{ width: size, height: size, display: 'block' }} viewBox="0 0 24 24">
      <path d="M16.6 16.6l5 5" stroke="#6b6a68" strokeWidth={3} strokeLinecap="round" />
      <circle cx={10} cy={10} r={9} fill="#c9c8c5" />
      <circle cx={10} cy={10} r={7} fill={color} />
      <path d="M10 5.4l1.4 2.9 3.2.4-2.4 2.2.6 3.2L10 12.6l-2.8 1.5.6-3.2-2.4-2.2 3.2-.4z" fill="#fff" />
    </svg>
  );
}

/** A magnifier with a spark: the button to the full analysis. */
function AnalysisIcon({ x, y, size }: { x: number; y: number; size: number }) {
  return (
    <svg style={iconBox(x, y, size)} viewBox="0 0 24 24">
      <circle cx={10.5} cy={10.5} r={7.5} fill="none" stroke={COLORS.icon} strokeWidth={2.4} />
      <path d="M16 16l5.5 5.5" stroke={COLORS.icon} strokeWidth={2.6} strokeLinecap="round" />
      <path d="M11.5 6.5l-3 4.5h3l-1 3.5 3-4.5h-3z" fill={COLORS.icon} />
    </svg>
  );
}
