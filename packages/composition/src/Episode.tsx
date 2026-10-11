import { typeOutStartSec, type EpisodeProps, type Moment, type Theme } from '@als/schema';
import { Audio, Video } from '@remotion/media';
import { useMemo } from 'react';
import { AbsoluteFill, Freeze, Sequence, useCurrentFrame, useVideoConfig } from 'remotion';
import { cardMotion, revealAt, type FrameSize } from './card.ts';
import { MoveCard } from './MoveCard.tsx';
import { moveNumbers } from './notation.ts';
import { buildTimeline, type Segment } from './timeline.ts';

/**
 * The finished episode: the source clip with a freeze and a move card at every
 * moment. Pure: everything arrives through props, and every frame is derived
 * from the frame number, so the Player and the renderer draw identical frames.
 */
export function Episode({ src, durationSec, moments, characters, theme }: EpisodeProps) {
  const { fps, width, height } = useVideoConfig();
  const timeline = useMemo(() => buildTimeline(moments, fps, durationSec), [moments, fps, durationSec]);
  const names = useMemo(() => new Map(characters.map((c) => [c.id, c.name])), [characters]);
  const numbers = useMemo(() => moveNumbers(moments, characters), [moments, characters]);

  return (
    <AbsoluteFill style={{ backgroundColor: 'black', overflow: 'hidden' }}>
      {timeline.segments.map((segment) => {
        const playFrames = segment.sourceEnd - segment.sourceStart;
        const total = playFrames + (segment.hold?.frames ?? 0);
        if (total <= 0) return null;
        const moment = segment.hold ? moments[segment.hold.index] : undefined;
        return (
          // One sequence per play-then-hold segment, so the same video keeps
          // playing into its freeze. Premounting loads the next segment's video
          // on its first frame before it is needed.
          <Sequence
            key={segment.hold?.momentId ?? 'tail'}
            from={segment.outStart}
            durationInFrames={total}
            premountFor={fps}
            name={moment ? `${moment.classification}: ${moment.moveLabel}` : 'tail'}
          >
            <SegmentView
              src={src}
              segment={segment}
              moment={moment}
              actorName={moment?.actorId ? names.get(moment.actorId) : undefined}
              moveNumber={moment ? numbers.get(moment.id) : undefined}
              theme={theme}
              frameSize={{ width, height }}
              fps={fps}
            />
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
}

interface SegmentViewProps {
  src: string;
  segment: Segment;
  moment: Moment | undefined;
  actorName: string | undefined;
  moveNumber: string | undefined;
  theme: Theme;
  frameSize: FrameSize;
  fps: number;
}

function SegmentView({ src, segment, moment, actorName, moveNumber, theme, frameSize, fps }: SegmentViewProps) {
  const frame = useCurrentFrame();
  const { hold } = segment;
  const playFrames = segment.sourceEnd - segment.sourceStart;
  const holding = hold !== undefined && frame >= playFrames;
  const progress = holding ? (frame - playFrames) / hold.frames : 0;
  const motion = holding ? cardMotion(progress, hold.frames, fps, theme) : undefined;
  const holdSec = (hold?.frames ?? 0) / fps;
  const reveal =
    holding && moment ? revealAt(moment.explanation, progress * holdSec - typeOutStartSec(theme.timing), holdSec, theme.timing) : undefined;
  const { treatment, dim, pushIn } = theme.freeze;
  const zoom = holding && treatment === 'push-in' ? 1 + (pushIn - 1) * progress : 1;

  return (
    <AbsoluteFill>
      <AbsoluteFill style={{ transform: zoom === 1 ? undefined : `scale(${zoom})` }}>
        {/* Frame numbers inside the sequence are relative, so the hold shows source frame hold.sourceFrame. */}
        <Freeze frame={(hold?.sourceFrame ?? segment.sourceStart) - segment.sourceStart} active={(f) => hold !== undefined && f >= playFrames}>
          <Video src={src} trimBefore={segment.sourceStart} objectFit="contain" style={{ width: '100%', height: '100%' }} />
        </Freeze>
      </AbsoluteFill>

      {motion && treatment === 'dim' && <AbsoluteFill style={{ backgroundColor: `rgba(0, 0, 0, ${dim * motion.freeze})` }} />}
      {motion && moment && (
        <MoveCard
          moment={moment}
          actorName={actorName}
          moveNumber={moveNumber}
          theme={theme}
          frame={frameSize}
          visibility={motion.visibility}
          enter={motion.enter}
          badgeScale={motion.badge}
          badgeVisibility={motion.badgeVisibility}
          reveal={reveal}
        />
      )}
      {hold && theme.timing.sting && (
        <Sequence from={playFrames} durationInFrames={hold.frames}>
          <Audio src={theme.timing.sting} />
        </Sequence>
      )}
    </AbsoluteFill>
  );
}
