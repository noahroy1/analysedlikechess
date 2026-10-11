import type { Character, Moment } from '@als/schema';
import { describe, expect, it } from 'vitest';
import { moveNumbers } from './notation.ts';

const cast: Character[] = [
  { id: 'carl', name: 'Carl', speakerLabels: [], side: 'white' },
  { id: 'frank', name: 'Frank', speakerLabels: [], side: 'black' },
  { id: 'extra', name: 'Extra', speakerLabels: [] },
];
const at = (id: string, sourceTime: number, actorId?: string) => ({ id, sourceTime, ...(actorId ? { actorId } : {}) }) as Moment;
const numbers = (moments: Moment[]) => [...moveNumbers(moments, cast).entries()];

describe('moveNumbers', () => {
  it('numbers White plainly and Black with an ellipsis, like the creator', () => {
    // The creator's motel scene: Carl, then Frank twice, then Carl.
    expect(numbers([at('a', 1, 'carl'), at('b', 2, 'frank'), at('c', 3, 'frank'), at('d', 4, 'carl')])).toEqual([
      ['a', '1'],
      ['b', '1...'],
      ['c', '2...'],
      ['d', '3'],
    ]);
  });

  it('implies the missing move when White plays twice', () => {
    expect(numbers([at('a', 1, 'carl'), at('b', 2, 'carl')])).toEqual([
      ['a', '1'],
      ['b', '2'],
    ]);
  });

  it('starts at 1... when Black moves first', () => {
    expect(numbers([at('a', 1, 'frank'), at('b', 2, 'carl')])).toEqual([
      ['a', '1...'],
      ['b', '2'],
    ]);
  });

  it('skips moves with no actor or no side, and sorts by time', () => {
    expect(numbers([at('late', 9, 'frank'), at('none', 1), at('extra', 2, 'extra'), at('first', 3, 'carl')])).toEqual([
      ['first', '1'],
      ['late', '1...'],
    ]);
  });
});
