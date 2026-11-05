import type { Character, Project } from '@als/schema';

/** "1:23.4" for the timeline's readers; seconds stay exact in brackets. */
const clock = (sec: number) => {
  const m = Math.floor(sec / 60);
  return `${m}:${(sec - m * 60).toFixed(1).padStart(4, '0')}`;
};

/** Character name for a diarization label, or "Speaker X" while unnamed. */
export function speakerName(characters: readonly Character[], label: string): string {
  return characters.find((c) => c.speakerLabels.includes(label))?.name ?? `Speaker ${label}`;
}

/** Everyone the Analyst may credit with a move: named characters, then any unnamed speakers. */
export function castNames(project: Project): string[] {
  const named = project.context.characters.map((c) => c.name).filter(Boolean);
  const speakers = [...new Set(project.transcript?.utterances.map((u) => u.speaker) ?? [])];
  const unnamed = speakers.filter((l) => !project.context.characters.some((c) => c.speakerLabels.includes(l))).map((l) => `Speaker ${l}`);
  return [...new Set([...named, ...unnamed])];
}

/**
 * One merged, time-ordered text timeline for the Analyst: cuts, utterances
 * (with ids and speaker names), scene notes and tagged sounds. Times are
 * seconds from the start of the clip.
 */
export function timelineText(project: Project): string {
  const { characters } = project.context;
  const entries: { at: number; order: number; line: string }[] = [];
  const add = (at: number, order: number, line: string) => entries.push({ at, order, line });

  (project.shots ?? []).forEach((shot, i) => add(shot.start, 0, `[${shot.start.toFixed(2)}] CUT to shot ${i + 1}`));
  for (const note of project.sceneNotes ?? []) {
    add(note.start, 1, `[${note.start.toFixed(2)}-${note.end.toFixed(2)}] ON SCREEN: ${note.text}`);
  }
  for (const event of project.transcript?.events ?? []) {
    add(event.start, 2, `[${event.start.toFixed(2)}] SOUND: ${event.text}`);
  }
  for (const u of project.transcript?.utterances ?? []) {
    add(u.start, 3, `[${u.start.toFixed(2)}-${u.end.toFixed(2)}] ${u.id} ${speakerName(characters, u.speaker)}: "${u.text}"`);
  }
  entries.sort((a, b) => a.at - b.at || a.order - b.order);

  const { source, context } = project;
  const header = [
    `CLIP: ${clock(source.durationSec)} long${context.movieTitle ? `, from "${context.movieTitle}"` : ''}.`,
    context.sceneNote ? `SCENE: ${context.sceneNote}` : undefined,
    `CAST: ${castNames(project).join(', ') || 'unknown'}`,
    'TIMELINE (times are seconds from the start of the clip; u-ids identify utterances):',
  ].filter(Boolean);
  return [...header, ...entries.map((e) => e.line)].join('\n');
}
