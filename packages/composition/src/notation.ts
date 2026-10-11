import type { Character, Moment } from '@als/schema';

/**
 * Chess move numbers for the cards, from each actor's side: White's moves read
 * "3", Black's "3...". Turns alternate as in a game, so when one side moves
 * twice in a row the other side's move in between is implied: White, Black,
 * Black reads "1", "1...", "2...". Moves with no actor, or an actor with no
 * side, get no number and do not advance the count.
 */
export function moveNumbers(moments: readonly Moment[], characters: readonly Character[]): Map<string, string> {
  const sides = new Map(characters.map((c) => [c.id, c.side]));
  const numbers = new Map<string, string>();
  let move = 1;
  let toMove: 'white' | 'black' = 'white';
  for (const m of [...moments].sort((a, b) => a.sourceTime - b.sourceTime)) {
    const side = m.actorId ? sides.get(m.actorId) : undefined;
    if (!side) continue;
    if (side === 'white') {
      // Black's reply was implied: the next White move starts a new number.
      if (toMove === 'black') move += 1;
      numbers.set(m.id, `${move}`);
      toMove = 'black';
    } else {
      numbers.set(m.id, `${move}...`);
      move += 1;
      toMove = 'white';
    }
  }
  return numbers;
}
