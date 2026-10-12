import { describe, expect, it } from 'vitest';
import { portraitCrop, portraitFile } from './portrait.ts';

describe('portraitCrop', () => {
  const source = { width: 1920, height: 1080 };

  it('turns fractions of the frame into a square of source pixels', () => {
    expect(portraitCrop({ x: 0.25, y: 0.1, size: 0.5 }, source)).toEqual({ side: 540, x: 480, y: 108 });
  });

  it('keeps the square inside the frame', () => {
    expect(portraitCrop({ x: 0.9, y: 0.9, size: 0.5 }, source)).toEqual({ side: 540, x: 1380, y: 540 });
    expect(portraitCrop({ x: 0, y: 0, size: 1 }, { width: 720, height: 1280 })).toEqual({ side: 720, x: 0, y: 0 });
  });
});

describe('portraitFile', () => {
  it('names each crop on its own, under portraits/', () => {
    const a = portraitFile({ characterId: 'c-Walter White', sourceTime: 1, x: 0, y: 0, size: 0.5 });
    const b = portraitFile({ characterId: 'c-Walter White', sourceTime: 2, x: 0, y: 0, size: 0.5 });
    expect(a).toMatch(/^portraits\/c-walter-white-[0-9a-f]{8}\.jpg$/);
    expect(a).not.toBe(b);
  });
});
