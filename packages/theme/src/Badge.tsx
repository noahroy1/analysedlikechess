import type { Badge as BadgeSpec } from '@als/schema';
import type { ReactNode } from 'react';

type Glyph = Extract<BadgeSpec, { kind: 'glyph' }>['glyph'];

const TEXT_GLYPHS: Partial<Record<Glyph, string>> = {
  'double-exclaim': '!!',
  exclaim: '!',
  'exclaim-question': '?!',
  question: '?',
  'double-question': '??',
};

// Icon glyphs on a 24-unit grid, centred in the badge.
const ICONS: Partial<Record<Glyph, ReactNode>> = {
  star: <path d="M12 3.6l2.5 5.3 5.8.7-4.3 4 1.1 5.7L12 16.5l-5.1 2.8 1.1-5.7-4.3-4 5.8-.7z" fill="currentColor" />,
  'thumbs-up': (
    <path
      d="M4 10.5h3V19H4zM8.6 19V10.3l3.6-6.1c1.3 0 2.2 1 2 2.3l-.6 3h4.6c1.2 0 2 1.1 1.8 2.2l-1.2 5.8c-.2 1-1 1.5-2 1.5z"
      fill="currentColor"
    />
  ),
  check: <path d="M5.5 12.5l4.2 4.2 8.8-9.4" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" />,
  book: (
    <g fill="none" stroke="currentColor" strokeWidth={2} strokeLinejoin="round">
      <path d="M12 7.2C9.8 5.6 7 5.2 4 6v11.6c3-.8 5.8-.4 8 1.2 2.2-1.6 5-2 8-1.2V6c-3-.8-5.8-.4-8 1.2z" />
      <path d="M12 7.2v11.6" />
    </g>
  ),
  cross: <path d="M7.2 7.2l9.6 9.6M16.8 7.2l-9.6 9.6" stroke="currentColor" strokeWidth={3.2} strokeLinecap="round" />,
};

export interface BadgeProps {
  badge: BadgeSpec;
  color: string;
  size: number;
  fontFamily?: string;
}

/** A classification badge: a coloured disc with the glyph in white, or the theme's own image. */
export function Badge({ badge, color, size, fontFamily }: BadgeProps) {
  if (badge.kind === 'image') {
    return <img src={badge.src} alt="" width={size} height={size} style={{ display: 'block' }} />;
  }
  const text = TEXT_GLYPHS[badge.glyph];
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={{ display: 'block', color: '#fff', flexShrink: 0 }}>
      <circle cx={12} cy={12} r={12} fill={color} />
      {text ? (
        <text
          x={12}
          y={12}
          dy="0.36em"
          textAnchor="middle"
          fill="currentColor"
          fontSize={text.length > 1 ? 12 : 15}
          fontWeight={800}
          letterSpacing={text.length > 1 ? -0.8 : 0}
          fontFamily={fontFamily ?? 'ui-sans-serif, system-ui, sans-serif'}
        >
          {text}
        </text>
      ) : (
        ICONS[badge.glyph]
      )}
    </svg>
  );
}
