import type { Moment, Theme } from '@als/schema';
import { Badge } from '@als/theme';
import type { CSSProperties } from 'react';
import { cardRect, type FrameSize } from './card.ts';

export interface MoveCardProps {
  moment: Moment;
  actorName?: string;
  theme: Theme;
  frame: FrameSize;
  /** 0-1 opacity. */
  visibility: number;
  /** 0-1 entrance. */
  enter: number;
}

/**
 * The move card. Its only inputs are the moment, the theme and animation values.
 * TODO(open-decision): match the creator's exact card look (fonts, layout, wording) in Phase 6.
 */
export function MoveCard({ moment, actorName, theme, frame, visibility, enter }: MoveCardProps) {
  const rect = cardRect(moment.card, frame, theme);
  const u = rect.unit;
  const { card } = theme;
  const style = theme.classifications[moment.classification];
  const position: CSSProperties = {
    left: rect.left,
    right: rect.right,
    top: rect.top,
    bottom: rect.bottom,
  };

  return (
    <div
      data-moment-id={moment.id}
      style={{
        position: 'absolute',
        ...position,
        width: rect.width,
        boxSizing: 'border-box',
        padding: card.padding * u,
        borderRadius: card.radius * u,
        background: card.background,
        color: card.textColor,
        fontFamily: card.fontFamily,
        boxShadow: card.shadow ? `0 ${12 * u}px ${40 * u}px rgba(0, 0, 0, 0.45)` : undefined,
        borderLeft: `${6 * u}px solid ${style.color}`,
        opacity: visibility,
        transform: `translateY(${(1 - enter) * 18 * u}px)`,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 18 * u }}>
        <Badge badge={style.badge} color={style.color} size={card.badgeSize * u} fontFamily={card.fontFamily} />
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              fontSize: card.labelSize * u,
              fontWeight: 800,
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
              color: style.color,
              lineHeight: 1.1,
            }}
          >
            {style.label}
          </div>
          <div style={{ fontSize: card.titleSize * u, fontWeight: 700, lineHeight: 1.18, marginTop: 4 * u }}>
            {actorName && <span style={{ color: card.mutedColor, fontWeight: 600 }}>{actorName}: </span>}
            {moment.moveLabel}
          </div>
        </div>
      </div>

      {moment.explanation && (
        <p
          style={{
            margin: `${16 * u}px 0 0`,
            fontSize: card.bodySize * u,
            lineHeight: 1.36,
            display: '-webkit-box',
            WebkitBoxOrient: 'vertical',
            WebkitLineClamp: card.lineClamp,
            overflow: 'hidden',
          }}
        >
          {moment.explanation}
        </p>
      )}

      {moment.bestMove && (
        <div
          style={{
            marginTop: 16 * u,
            paddingTop: 14 * u,
            borderTop: `${Math.max(1, 1.5 * u)}px solid rgba(255, 255, 255, 0.14)`,
            fontSize: card.bodySize * 0.92 * u,
            lineHeight: 1.32,
          }}
        >
          <span
            style={{
              fontSize: card.labelSize * 0.85 * u,
              fontWeight: 800,
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
              color: theme.classifications.best.color,
              marginRight: 10 * u,
            }}
          >
            Best move
          </span>
          {moment.bestMove}
        </div>
      )}
    </div>
  );
}
