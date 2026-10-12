import { z } from 'zod';
import type { Source } from '@als/schema';
import { run } from './run.ts';

// The subset of ffprobe's JSON output we read.
const ProbeOutput = z.object({
  streams: z.array(
    z.looseObject({
      codec_type: z.string().optional(),
      width: z.number().optional(),
      height: z.number().optional(),
      r_frame_rate: z.string().optional(),
      avg_frame_rate: z.string().optional(),
      duration: z.string().optional(),
      side_data_list: z.array(z.looseObject({ rotation: z.number().optional() })).optional(),
      disposition: z.looseObject({ attached_pic: z.number().optional() }).optional(),
    }),
  ),
  format: z.looseObject({ duration: z.string().optional() }),
});

export type ProbeResult = Pick<Source, 'fps' | 'durationSec' | 'width' | 'height' | 'hasAudio'>;

export class NotAVideoError extends Error {}

/** "24000/1001" -> 23.976... */
export function parseRate(rate: string | undefined): number {
  const [num, den = '1'] = (rate ?? '').split('/');
  const value = Number(num) / Number(den);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export function readProbe(json: unknown): ProbeResult {
  const probe = ProbeOutput.parse(json);
  const video = probe.streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  if (!video?.width || !video.height) throw new NotAVideoError('no video stream');

  // r_frame_rate is the stream's base rate; avg_frame_rate covers containers that leave it at e.g. 90000/1.
  const r = parseRate(video.r_frame_rate);
  const fps = r > 0 && r <= 240 ? r : parseRate(video.avg_frame_rate);
  if (!fps) throw new NotAVideoError('unknown frame rate');

  const durationSec = Number(video.duration ?? probe.format.duration);
  if (!(durationSec > 0)) throw new NotAVideoError('unknown duration');

  // Phone footage stores portrait video as rotated landscape; report the size as displayed.
  const rotation = Math.abs(video.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? 0) % 180;
  const [width, height] = rotation === 90 ? [video.height, video.width] : [video.width, video.height];

  return {
    fps,
    durationSec,
    width,
    height,
    hasAudio: probe.streams.some((s) => s.codec_type === 'audio'),
  };
}

export async function probe(file: string): Promise<ProbeResult> {
  let stdout: string;
  try {
    stdout = await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file]);
  } catch {
    throw new NotAVideoError('ffprobe could not read the file');
  }
  return readProbe(JSON.parse(stdout));
}
