import { NOTATION, NO_BEST_MOVE, type Moment, type Theme } from '@als/schema';
import { Badge } from '@als/theme';
import type { CSSProperties, HTMLAttributes, ReactNode, Ref } from 'react';
import { cardRect, type FrameSize, type Reveal } from './card.ts';

export type CardField = 'moveLabel' | 'explanation' | 'bestMove' | 'motif';

/**
 * Editor hooks. The render path never passes these, so they cannot change
 * exported frames; the editor uses them to draw the same card with editable fields.
 */
export interface MoveCardEditing {
  badge?: (badge: ReactNode) => ReactNode;
  field?: (name: CardField, value: string) => ReactNode;
  /** Show empty fields (as editing targets) instead of collapsing them. */
  showEmptyFields?: boolean;
  /** Show every explanation line while editing. */
  unclamped?: boolean;
  rootProps?: HTMLAttributes<HTMLDivElement>;
  rootRef?: Ref<HTMLDivElement>;
  /** Extra content inside the card, e.g. resize handles. */
  children?: ReactNode;
}

export interface MoveCardProps {
  moment: Moment;
  actorName?: string;
  /** Chess move number from the actor's side, e.g. "4" or "4..." (see moveNumbers). */
  moveNumber?: string;
  theme: Theme;
  frame: FrameSize;
  /** 0-1 opacity. */
  visibility: number;
  /** 0-1 entrance. */
  enter: number;
  /** Scale and opacity of a badge drawn beside the card; omitted, it shows at full size. */
  badgeScale?: number;
  badgeVisibility?: number;
  /** How far the explanation has typed out; omitted, the card shows all its text (the editor). */
  reveal?: Reveal;
  editing?: MoveCardEditing;
}

/**
 * The move card. Its only inputs are the moment, the theme and animation values.
 * The outer box only places the card (the editor measures and drags it); the
 * card's look and its animation live on the inner box, so a badge beside the
 * card can pop in before the card itself shows.
 */
export function MoveCard(props: MoveCardProps) {
  const { moment, theme, frame, visibility, enter, editing } = props;
  const rect = cardRect(moment.card, frame, theme);
  const u = rect.unit;
  const { card } = theme;
  const style = theme.classifications[moment.classification];
  const headline = card.layout === 'headline';
  const badge = (
    <Badge badge={style.badge} color={style.color} size={card.badgeSize * u} fontFamily={card.fontFamily} />
  );
  const position: CSSProperties = { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };

  return (
    <div
      {...editing?.rootProps}
      ref={editing?.rootRef}
      data-moment-id={moment.id}
      style={{ ...editing?.rootProps?.style, position: 'absolute', ...position, width: rect.width }}
    >
      {headline && (
        <div
          data-part="badge"
          style={{
            position: 'absolute',
            right: `calc(100% + ${card.badgeGap * u}px)`,
            top: card.badgeSize * 0.6 * u,
            opacity: props.badgeVisibility ?? 1,
            transform: `scale(${props.badgeScale ?? 1})`,
            filter: `drop-shadow(0 ${5 * u}px ${3 * u}px rgba(0, 0, 0, 0.4))`,
          }}
        >
          {editing?.badge ? editing.badge(badge) : badge}
        </div>
      )}
      <div
        style={{
          boxSizing: 'border-box',
          padding: card.padding * u,
          borderRadius: card.radius * u,
          background: card.background,
          color: card.textColor,
          fontFamily: card.fontFamily,
          boxShadow: card.shadow ? `0 ${12 * u}px ${40 * u}px rgba(0, 0, 0, 0.45)` : undefined,
          borderLeft: `${card.accentWidth * u}px solid ${style.color}`,
          opacity: visibility,
          transform: `translateY(${(1 - enter) * (headline ? 10 : 18) * u}px)`,
        }}
      >
        {headline ? <HeadlineTop {...props} unit={u} /> : <StackedTop {...props} unit={u} badge={badge} />}
        <Body {...props} unit={u} />
      </div>
      {editing?.children}
    </div>
  );
}

type PartProps = MoveCardProps & { unit: number };

const field = (props: MoveCardProps, name: CardField, value: string) => props.editing?.field?.(name, value) ?? value;

/** "<Move> is <phrase>" in the rating colour, then "<number> <actor> · <Move><notation>" in grey. */
function HeadlineTop(props: PartProps) {
  const { moment, theme, actorName, moveNumber, unit: u } = props;
  const style = theme.classifications[moment.classification];
  const who = [moveNumber, actorName].filter(Boolean).join(' ');
  const move = `${moment.moveLabel.trim()}${NOTATION[moment.classification]}`;
  return (
    <>
      <div style={{ fontSize: theme.card.titleSize * u, fontWeight: 700, lineHeight: 1.2, color: style.color }}>
        {field(props, 'moveLabel', moment.moveLabel)} is {style.phrase}
      </div>
      <div style={{ fontSize: theme.card.labelSize * u, fontWeight: 700, lineHeight: 1.3, color: theme.card.mutedColor, marginTop: 4 * u }}>
        {[who, move].filter(Boolean).join(' · ')}
      </div>
    </>
  );
}

/** The app's own layout: badge inside the card, the rating label over "Actor: Move". */
function StackedTop(props: PartProps & { badge: ReactNode }) {
  const { moment, theme, actorName, unit: u, editing, badge } = props;
  const style = theme.classifications[moment.classification];
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 18 * u }}>
      {editing?.badge ? editing.badge(badge) : badge}
      <div style={{ minWidth: 0 }}>
        <div
          style={{
            fontSize: theme.card.labelSize * u,
            fontWeight: 800,
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
            color: style.color,
            lineHeight: 1.1,
          }}
        >
          {style.label}
        </div>
        <div style={{ fontSize: theme.card.titleSize * u, fontWeight: 700, lineHeight: 1.18, marginTop: 4 * u }}>
          {actorName && <span style={{ color: theme.card.mutedColor, fontWeight: 600 }}>{actorName}: </span>}
          {field(props, 'moveLabel', moment.moveLabel)}
        </div>
      </div>
    </div>
  );
}

/** The breakdown (typing out during a hold), then the better move and the motif chip once it has. */
function Body(props: PartProps) {
  const { moment, theme, reveal, editing, unit: u } = props;
  const { card } = theme;
  const headline = card.layout === 'headline';
  const showEmpty = editing?.showEmptyFields ?? false;
  const typed = reveal === undefined || reveal.after > 0;
  const bestMove = moment.bestMove ?? '';
  const motif = moment.motif ?? '';
  const showExplanation = reveal ? reveal.words.length > 0 : moment.explanation !== '' || showEmpty;
  const showBestMove = typed && !NO_BEST_MOVE.has(moment.classification) && (bestMove !== '' || showEmpty);
  const showMotif = typed && (motif !== '' || showEmpty);
  const after = reveal?.after;

  return (
    <>
      {showExplanation && (
        <p
          style={{
            margin: `${(headline ? 12 : 16) * u}px 0 0`,
            fontSize: card.bodySize * u,
            lineHeight: headline ? 1.33 : 1.36,
            display: '-webkit-box',
            WebkitBoxOrient: 'vertical',
            WebkitLineClamp: editing?.unclamped ? 'unset' : card.lineClamp,
            overflow: 'hidden',
          }}
        >
          {reveal
            ? reveal.words.map((word, i) => (
                // Words type out one at a time, the newest fading in.
                <span key={i} style={{ opacity: word.opacity }}>
                  {i > 0 ? ' ' : ''}
                  {word.text}
                </span>
              ))
            : field(props, 'explanation', moment.explanation)}
        </p>
      )}

      {showBestMove &&
        (headline ? (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10 * u,
              marginTop: 12 * u,
              fontSize: card.labelSize * u,
              fontWeight: 700,
              lineHeight: 1.3,
              color: card.betterColor,
              opacity: after,
            }}
          >
            <BranchIcon size={28 * u} color={card.betterColor} />
            <span>Better was: {field(props, 'bestMove', bestMove)}</span>
          </div>
        ) : (
          <div
            style={{
              marginTop: 16 * u,
              paddingTop: 14 * u,
              borderTop: `${Math.max(1, 1.5 * u)}px solid rgba(255, 255, 255, 0.14)`,
              fontSize: card.bodySize * 0.92 * u,
              lineHeight: 1.32,
              opacity: after,
            }}
          >
            <span
              style={{
                fontSize: card.labelSize * 0.85 * u,
                fontWeight: 800,
                letterSpacing: '0.06em',
                textTransform: 'uppercase',
                color: card.betterColor,
                marginRight: 10 * u,
              }}
            >
              Best move
            </span>
            {field(props, 'bestMove', bestMove)}
          </div>
        ))}

      {showMotif && (
        <div style={{ marginTop: 12 * u, opacity: after }}>
          <span
            data-part="motif"
            style={{
              display: 'inline-block',
              padding: `${5 * u}px ${13 * u}px`,
              borderRadius: 999,
              background: card.chipBackground,
              color: card.chipTextColor,
              fontSize: card.labelSize * 0.86 * u,
              fontWeight: 700,
              lineHeight: 1.25,
            }}
          >
            {field(props, 'motif', motif)}
          </span>
        </div>
      )}
    </>
  );
}

/** A disc with a branching line: the other move that was available. */
function BranchIcon({ size, color }: { size: number; color: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={{ display: 'block', flexShrink: 0 }}>
      <circle cx={12} cy={12} r={12} fill={color} opacity={0.75} />
      <path d="M12 19v-7M12 12L7.2 6.6M12 12l4.8-5.4" stroke="#fff" strokeWidth={2.6} strokeLinecap="round" fill="none" />
    </svg>
  );
}
