import { describe, expect, it } from 'vitest';
import { portraitCrop } from './portrait.ts';

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
