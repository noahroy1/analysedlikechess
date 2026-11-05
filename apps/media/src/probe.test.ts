import { describe, expect, it } from 'vitest';
import { NotAVideoError, parseRate, readProbe } from './probe.ts';

const video = { codec_type: 'video', width: 1920, height: 1080, r_frame_rate: '60/1', duration: '108.05' };

describe('parseRate', () => {
  it('parses fractional rates', () => {
    expect(parseRate('24000/1001')).toBeCloseTo(23.976, 3);
    expect(parseRate('0/0')).toBe(0);
    expect(parseRate(undefined)).toBe(0);
  });
});

describe('readProbe', () => {
  it('reads size, rate, duration and audio', () => {
    const probe = { streams: [video, { codec_type: 'audio' }], format: { duration: '108.11' } };
    expect(readProbe(probe)).toEqual({ fps: 60, durationSec: 108.05, width: 1920, height: 1080, hasAudio: true });
  });

  it('falls back to the container duration and average rate', () => {
    const probe = {
      streams: [{ ...video, duration: undefined, r_frame_rate: '90000/1', avg_frame_rate: '30/1' }],
      format: { duration: '12.5' },
    };
    expect(readProbe(probe)).toMatchObject({ fps: 30, durationSec: 12.5, hasAudio: false });
  });

  it('reports rotated phone video at its displayed size', () => {
    const probe = { streams: [{ ...video, side_data_list: [{ rotation: -90 }] }], format: {} };
    expect(readProbe(probe)).toMatchObject({ width: 1080, height: 1920 });
  });

  it('skips cover art and rejects files with no video', () => {
    const cover = { codec_type: 'video', width: 600, height: 600, disposition: { attached_pic: 1 } };
    expect(() => readProbe({ streams: [cover, { codec_type: 'audio' }], format: {} })).toThrow(NotAVideoError);
  });
});
