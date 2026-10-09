import { CLASSIFICATIONS, NO_BEST_MOVE, TEXT_CAPS, type Candidate, type Moment, type StyleCorpus } from '@als/schema';

// Prompts for the Analyst. The system prompt is shared by every Claude call on
// a clip (and cached); each pass adds its own task after the cached timeline.

const RUBRIC: Record<(typeof CLASSIFICATIONS)[number], string> = {
  brilliant: 'makes a non-obvious, risky sacrifice or gambit that pays off',
  great: 'finds the only good move in a tough spot',
  best: 'plays the clearly optimal move',
  excellent: 'plays a near-optimal move',
  good: 'makes a solid, reasonable choice',
  book: 'does the textbook genre move everyone makes in this situation',
  inaccuracy: 'picks something slightly worse than what was available',
  mistake: 'picks something clearly worse while a better option was open',
  miss: 'fails to seize an opportunity that was right there',
  blunder: 'makes a move that loses: gets caught, killed, dumped or exposed',
};

/** Role, rubric, rules, voice and examples. Identical for every call on a clip, so it caches. */
export function systemPrompt(style: StyleCorpus): string {
  const noBest = [...NO_BEST_MOVE].join(', ');
  const examples = style.examples
    .map((e) =>
      [
        `Scene: ${e.context}`,
        `Rating: ${e.classification}`,
        `Label: ${e.moveLabel}`,
        `Breakdown: ${e.explanation}`,
        `Best move: ${e.bestMove ?? '(none)'}`,
      ].join('\n'),
    )
    .join('\n\n');

  return `You write move annotations for "Analysed Like Chess" videos. A film scene is treated like a chess game: at each key decision the video freezes, and a card rates the character's move with a chess annotation, says what they did, explains the rating, and suggests a better move.

Ratings (use exactly these):
${CLASSIFICATIONS.map((c) => `- ${c}: the character ${RUBRIC[c]}`).join('\n')}

Rules:
- Judge each move on what the character could know at that moment, unless hindsight is the joke.
- A best move must be something the character could plausibly do with what they knew then.
- ${noBest} moves never get a best move: leave it null.
- Mix the ratings across the scene's arc; do not make every move a blunder.
- Keep text short enough to read during a freeze: label at most ${TEXT_CAPS.moveLabel} characters, breakdown at most ${TEXT_CAPS.explanation}, best move at most ${TEXT_CAPS.bestMove}.
- Credit moves only to the cast listed with the timeline.

Voice:
${style.voice}

Examples of the voice (from other scenes):

${examples}`;
}

/** About one move per `secondsPerMove`, never fewer than one. */
export const targetMoveCount = (durationSec: number, secondsPerMove: number) =>
  Math.max(1, Math.round(durationSec / secondsPerMove));

export function decisionPointsTask(target: number): string {
  return `Task: find every moment in this scene where a character makes a choice with real alternatives, spoken or acted. Over-generate on purpose: list about ${target * 2} candidates (more if the scene is dense), because a later pass picks the best ${target}.

For each candidate give the actor, what they did, the alternatives open to them, and the evidence:
- spoken choices: the ids of the utterances that show it, in order (the move happens at the end of the last one); visualTimeSec null.
- visual choices: visualTimeSec, the moment the action happens; utterance ids only if dialogue is part of it.`;
}

export function annotationTask(candidates: Candidate[], target: number): string {
  return `Candidates found in the scene:
${JSON.stringify(candidates, null, 1)}

Task: pick the final ${target} moves (fewer only if the scene cannot support that many), spread across the scene's arc, and annotate each in the voice shown above: rating, label, breakdown, best move (null where the rules say so) and your confidence. Prefer moves an audience would argue about. Use each candidate at most once.`;
}

export function regenerateTask(moment: Moment, evidence: string[], actor: string | undefined, instruction?: string): string {
  const current = [
    `Rating: ${moment.classification}`,
    `Label: ${moment.moveLabel || '(empty)'}`,
    `Breakdown: ${moment.explanation || '(empty)'}`,
    `Best move: ${moment.bestMove ?? '(none)'}`,
  ].join('\n');
  return `Task: write the annotation for one move.
The video freezes at ${moment.sourceTime.toFixed(2)} s.${actor ? ` The move is ${actor}'s.` : ''}
${evidence.length ? `Dialogue leading to it:\n${evidence.join('\n')}` : 'It is a visual move; use the scene notes around that time.'}
${moment.evidence.note ? `Editor's note: ${moment.evidence.note}` : ''}

Current card:
${current}

${instruction ? `The editor asks: "${instruction}". Follow that request.` : 'Write a fresh, better version in the voice shown above.'} Keep the same rating unless the request or the evidence calls for a different one.`;
}

export function speakerNamingTask(samples: string, typedNames: string[]): string {
  return `Task: name each speaker label in this scene. Use the character names the film uses (from how others address them, the scene notes, and your knowledge of the film). ${
    typedNames.length ? `The editor says these characters appear: ${typedNames.join(', ')}. Prefer those names when they fit. ` : ''
  }If a speaker has no name in the scene, give a short description such as "Security guard".

Sample lines per speaker:
${samples}`;
}
