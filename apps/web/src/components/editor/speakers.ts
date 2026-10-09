const SPEAKER_COLORS = ['#7dd3fc', '#fca5a5', '#c4b5fd', '#fcd34d', '#86efac', '#f9a8d4', '#fdba74', '#a5b4fc'];

/** Stable colour per diarization label, in order of first appearance. */
export const speakerColor = (labels: readonly string[], label: string) =>
  SPEAKER_COLORS[Math.max(0, labels.indexOf(label)) % SPEAKER_COLORS.length]!;
