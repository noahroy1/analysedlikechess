import { themeUnit, type Theme } from '@als/schema';
import type { FrameSize } from './card.ts';
import { subtitleBaseline, type BarLayout } from './layout.ts';

export interface SubtitleLineProps {
  text: string;
  style: NonNullable<Theme['subtitles']>;
  frame: FrameSize;
  /** The evaluation bar on screen, which a narrow frame's line sits above. */
  bar?: BarLayout | undefined;
}

/** Where the baseline sits above the bottom of a one-em line box, as a share of the font size (Arial and system sans). */
const BASELINE_IN_BOX = 0.15;

/**
 * One line of dialogue, centred above the bottom edge. The outline is drawn
 * outside the letters (`paint-order`), so the fill keeps its full weight.
 */
export function SubtitleLine({ text, style, frame, bar }: SubtitleLineProps) {
  const unit = themeUnit(frame);
  return (
    <div
      data-testid="subtitle"
      style={{
        position: 'absolute',
        left: '50%',
        bottom: subtitleBaseline(style, frame, bar) - BASELINE_IN_BOX * style.fontSize * unit,
        transform: 'translateX(-50%)',
        width: 'max-content',
        maxWidth: style.maxWidth * frame.width,
        textAlign: 'center',
        fontFamily: style.fontFamily,
        fontSize: style.fontSize * unit,
        fontWeight: style.fontWeight,
        lineHeight: 1,
        color: style.color,
        WebkitTextStroke: style.strokeWidth > 0 ? `${2 * style.strokeWidth * unit}px ${style.strokeColor}` : undefined,
        paintOrder: 'stroke fill',
        strokeLinejoin: 'round',
        whiteSpace: 'pre-wrap',
      }}
    >
      {text}
    </div>
  );
}
