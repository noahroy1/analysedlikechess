import { describe, expect, it } from 'vitest';
import { portraitFile } from './portraits.ts';

describe('portraitFile', () => {
  it('names each crop on its own, under portraits/', () => {
    const a = portraitFile({ characterId: 'c-Walter White', sourceTime: 1, x: 0, y: 0, size: 0.5 });
    const b = portraitFile({ characterId: 'c-Walter White', sourceTime: 2, x: 0, y: 0, size: 0.5 });
    expect(a).toMatch(/^portraits\/c-walter-white-[0-9a-f]{8}\.jpg$/);
    expect(a).not.toBe(b);
  });
});
