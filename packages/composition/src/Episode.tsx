import { DEFAULT_START_EVAL, evalKeyframes, subtitleAt, typeOutStartSec, type EpisodeProps, type Moment, type Theme } from '@als/schema';
import { Audio, Video } from '@remotion/media';
import { useMemo } from 'react';
import { AbsoluteFill, Freeze, Sequence, useCurrentFrame, useVideoConfig } from 'remotion';
import { cardMotion, revealAt, type FrameSize } from './card.ts';
import { EvalBar, barPlayers } from './EvalBar.tsx';
import { evalBarAt, placeKeyframes } from './eval-bar.ts';
import { evalBarLayout, type BarLayout } from './layout.ts';
import { MoveCard } from './MoveCard.tsx';
import { moveNumbers } from './notation.ts';
import { soundCues } from './sounds.ts';
import { SubtitleLine } from './Subtitles.tsx';
import { buildTimeline, timeMapFrame, type Segment } from './timeline.ts';

/**
 * The finished episode: the source clip with a freeze and a move card at every
 * moment. Pure: everything arrives through props, and every frame is derived
 * from the frame number, so the Player and the renderer draw identical frames.
 */
export function Episode({ src, durationSec, moments, characters, theme, evalBar, evalBarScale, portraits, sounds, subtitles }: EpisodeProps) {
  const { fps, width, height } = useVideoConfig();
  const frame = useCurrentFrame();
  const timeline = useMemo(() => buildTimeline(moments, fps, durationSec), [moments, fps, durationSec]);
  const evalTrack = useMemo(
    () => placeKeyframes(evalKeyframes(evalBar, moments, characters), timeline),
    [evalBar, moments, characters, timeline],
  );
  const players = useMemo(() => barPlayers(characters, moments, portraits), [characters, moments, portraits]);
  const barLayout = useMemo(
    () => (theme.evalBar ? evalBarLayout(theme.evalBar, { width, height }, evalBarScale) : undefined),
    [theme.evalBar, width, height, evalBarScale],
  );
  const names = useMemo(() => new Map(characters.map((c) => [c.id, c.name])), [characters]);
  const numbers = useMemo(() => moveNumbers(moments, characters), [moments, characters]);
  const cues = useMemo(
    () => (sounds ? soundCues({ timeline, moments, characters, timing: theme.timing, sounds }) : []),
    [sounds, timeline, moments, characters, theme.timing],
  );

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
      {theme.subtitles && subtitles && <Subtitle subtitles={subtitles} sourceSec={timeMapFrame(timeline, frame).sourceFrame / fps} style={theme.subtitles} frame={{ width, height }} bar={barLayout} />}
      {theme.evalBar && (
        <EvalBar
          state={evalBarAt(evalBar?.start ?? DEFAULT_START_EVAL, evalTrack, frame, fps)}
          players={players}
          style={theme.evalBar}
          fontFamily={theme.card.fontFamily}
          frame={{ width, height }}
          scale={evalBarScale}
        />
      )}
      {cues.map((cue) => (
        // Premounting loads each sound a second ahead, so it starts on its frame.
        <Audio
          key={cue.key}
          name={cue.sound}
          src={cue.src}
          from={cue.from}
          durationInFrames={cue.frames}
          premountFor={fps}
          {...(cue.trimBefore ? { trimBefore: cue.trimBefore } : {})}
          {...(cue.loop ? { loop: true } : {})}
        />
      ))}
    </AbsoluteFill>
  );
}

/** The line on screen at a source time. A hold shows its frozen frame's time, so the line spoken before it stays up. */
function Subtitle({ subtitles, sourceSec, style, frame, bar }: { subtitles: NonNullable<EpisodeProps['subtitles']>; sourceSec: number; style: NonNullable<Theme['subtitles']>; frame: FrameSize; bar: BarLayout | undefined }) {
  const line = subtitleAt(subtitles, sourceSec);
  return line?.text.trim() ? <SubtitleLine text={line.text.trim()} style={style} frame={frame} bar={bar} /> : null;
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
