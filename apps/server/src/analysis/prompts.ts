import {
  BOOK_WINDOW_SEC,
  CLASSIFICATIONS,
  EVAL_DIRECTION,
  NO_BEST_MOVE,
  TEXT_CAPS,
  formatEvalSigned,
  type Candidate,
  type Classification,
  type Eval,
  type Moment,
  type StyleCorpus,
} from '@als/schema';

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
        `Motif: ${e.motif ?? '(none)'}`,
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
- Book is only for the scene's opening, the first ${BOOK_WINDOW_SEC} seconds. After that, rate a textbook move good.
- Mix the ratings across the scene's arc; do not make every move a blunder.
- Credit moves only to the cast listed with the timeline.

Format (the card is read during a freeze, so every field is short):
- Label: the move's name, two or three words in Title Case, at most ${TEXT_CAPS.moveLabel} characters. A nickname for the action, not a sentence.
- Breakdown: exactly two sentences, about 25 to 30 words, at most ${TEXT_CAPS.explanation} characters. Sentence one: what the character visibly does. Sentence two: the verdict.
- Best move: a two to four word command in Title Case, at most ${TEXT_CAPS.bestMove} characters.
- Motif: the chess idea the move embodies, as a one to three word chip in Title Case, at most ${TEXT_CAPS.motif} characters (Sacrifice, Zwischenzug, Quiet Move, Check, Fork, Pin, Gambit, Decoy, Deflection, Prophylaxis). Use it when a chess idea fits the move; leave it null rather than force one.

Writing (every word has to earn its place):
- Concrete over abstract: name the person, the object, the number, the place. Strong verbs, not stacked adjectives.
- No filler or hedging: never "just", "really", "basically", "actually", "clearly", "simply", "kind of", "seems", "perhaps".
- Never restate the label or the rating, and never open with a verdict word ("Textbook.", "Solid.", "Bold move.").
- Quote dialogue only when the words are the move, and then only a few of them.
- Present tense, third person. Name the character in the first sentence.
- No puns, rhetorical questions, exclamation marks, dashes or semicolons.

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

Task: pick the final ${target} moves (fewer only if the scene cannot support that many), spread across the scene's arc, and annotate each in the voice shown above: rating, label, breakdown, best move (null where the rules say so), motif and your confidence. Prefer moves an audience would argue about. Use each candidate at most once.

Also name the scene's protagonist, the character the audience follows, who plays White. Leave it null if no one clearly stands out.`;
}

/** One change of the bar, as Pass C sees it. */
export interface EvaluationItem {
  id: string;
  kind: 'card' | 'beat';
  sourceTime: number;
  actor?: string;
  side?: 'white' | 'black';
  classification?: Classification;
  moveLabel?: string;
  explanation?: string;
  /** For beats: what the character did. */
  action?: string;
  /** Set by the editor: keep this value. */
  fixed?: Eval;
}

const byDirection = (direction: 'gain' | 'loss' | 'either') =>
  CLASSIFICATIONS.filter((c) => EVAL_DIRECTION[c] === direction).join(', ');

export function evaluationTask(items: EvaluationItem[], fixedStart?: Eval): string {
  const lines = items.map((item) => {
    const who = item.actor ? `${item.actor}${item.side ? ` (${item.side === 'white' ? 'White' : 'Black'})` : ''}` : 'unknown';
    const what =
      item.kind === 'card'
        ? `${item.classification} "${item.moveLabel}": ${item.explanation}`
        : item.action ?? '';
    const fixed = item.fixed ? ` [FIXED at ${formatEvalSigned(item.fixed)}]` : '';
    return `[${item.sourceTime.toFixed(2)}] ${item.kind} ${item.id} · ${who} · ${what}${fixed}`;
  });
  return `The finished episode shows an evaluation bar beside the video, as a chess engine would: who is winning the scene, moment by moment. It changes at every card (a rated move, where the video freezes) and at every beat (a smaller decision, with no card, while the video plays).

Changes of the bar, in order:
${lines.join('\n')}

Task: give the evaluation after each of them, plus the start, the position as the scene opens${fixedStart ? ` (FIXED at ${formatEvalSigned(fixedStart)})` : ''}. Write them together as one curve: it is the scene's story told by the bar.

Values:
- pawns: White's advantage, one decimal (0.3, -1.2); 0 is level, and about ±1 is a clear edge, ±3 winning, beyond ±6 crushing.
- mate: a forced mate in so many moves (positive when White mates, negative when Black does), only when the outcome is sealed in the story. The count drops as the winning side keeps pressing (M6, then M5); a great defence can make it disappear.

Rules:
- The rating sets the direction for the player who moved: ${byDirection('gain')} gain them ground; ${byDirection('loss')} lose them ground; ${byDirection('either')} can go either way by a little.
- Size follows the rating: an inaccuracy costs a little, a mistake more, a blunder can lose the game; a great or brilliant move can turn it.
- Beats are nudges, smaller than any card, and never start or end a mate.
- Where a card's breakdown mentions the bar or the mate, match it.
- End where the scene ends: the last value says who won the scene.
- Keep every FIXED value exactly as given.
- reason: one short line on why the bar moves.`;
}

export function regenerateTask(moment: Moment, evidence: string[], actor: string | undefined, instruction?: string): string {
  const current = [
    `Rating: ${moment.classification}`,
    `Label: ${moment.moveLabel || '(empty)'}`,
    `Breakdown: ${moment.explanation || '(empty)'}`,
    `Best move: ${moment.bestMove ?? '(none)'}`,
    `Motif: ${moment.motif ?? '(none)'}`,
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
