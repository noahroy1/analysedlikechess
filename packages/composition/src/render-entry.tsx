// Entry point the server bundles for rendering. The Player imports <Episode> directly
// and never loads this file.
import type { RenderProps } from '@als/schema';
import { defaultTheme } from '@als/theme';
import { Composition, registerRoot, type CalculateMetadataFunction } from 'remotion';
import { Episode } from './Episode.tsx';
import { buildTimeline } from './timeline.ts';

/** The composition id the renderer selects. */
export const EPISODE_COMPOSITION = 'Episode';

function RenderEpisode({ fps: _fps, width: _width, height: _height, ...episode }: RenderProps) {
  return <Episode {...episode} />;
}

// Frame size and rate come from the source; the length is the source plus every hold,
// from the same timeline the Player uses.
const calculateMetadata: CalculateMetadataFunction<RenderProps> = ({ props }) => ({
  durationInFrames: buildTimeline(props.moments, props.fps, props.durationSec).outFrames,
  fps: props.fps,
  width: props.width,
  height: props.height,
});

// Placeholder props; every render passes its own snapshot.
const placeholder: RenderProps = {
  src: 'about:blank',
  durationSec: 1,
  moments: [],
  characters: [],
  theme: defaultTheme,
  fps: 30,
  width: 1920,
  height: 1080,
};

function Root() {
  return (
    <Composition
      id={EPISODE_COMPOSITION}
      component={RenderEpisode}
      durationInFrames={30}
      fps={30}
      width={1920}
      height={1080}
      defaultProps={placeholder}
      calculateMetadata={calculateMetadata}
    />
  );
}

registerRoot(Root);
