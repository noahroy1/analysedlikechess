import type { Character, Moment } from '@als/schema';

/** The character a name from the Analyst refers to: by name, or by a "Speaker A" label. */
export function characterByName(characters: readonly Character[], name: string): Character | undefined {
  const lower = name.trim().toLowerCase();
  const direct = characters.find((c) => c.name.trim().toLowerCase() === lower);
  if (direct) return direct;
  const label = /^speaker ([a-z]+)$/i.exec(name.trim())?.[1]?.toUpperCase();
  return label ? characters.find((c) => c.speakerLabels.includes(label)) : undefined;
}

/**
 * Sides for move numbering, set once per project: the protagonist plays White
 * and everyone else Black. With no protagonist, a coin flip among the
 * characters who make moves picks White. Sides already set (by an earlier run
 * or by hand in the Cast tab) are kept as they are.
 */
export function assignSides(
  characters: readonly Character[],
  moments: readonly Moment[],
  protagonist: string | null,
  random: () => number = Math.random,
): Character[] {
  if (characters.length === 0 || characters.some((c) => c.side)) return [...characters];
  const movers = characters.filter((c) => moments.some((m) => m.actorId === c.id));
  const pool = movers.length ? movers : characters;
  const white = (protagonist ? characterByName(characters, protagonist) : undefined) ?? pool[Math.floor(random() * pool.length)]!;
  return characters.map((c) => ({ ...c, side: c.id === white.id ? 'white' : 'black' }));
}
