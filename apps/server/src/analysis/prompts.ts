import {
  CLASSIFICATIONS,
  EVAL_DIRECTION,
  FORMAT_RULES,
  NO_BEST_MOVE,
  formatEvalSigned,
  textCaps,
  type Candidate,
  type Classification,
  type Eval,
  type Format,
  type Moment,
  type StyleCorpus,
} from '@als/schema';

// Prompts for the Analyst. The system prompt is shared by every Analyst call on
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

const writingRules = `Writing (every word has to earn its place):
- Concrete over abstract: name the person, the object, the number, the place. Strong verbs, not stacked adjectives. Never abstract summaries such as "the dynamic shifts" or "raises the stakes".
- No filler or hedging: never "just", "really", "basically", "actually", "clearly", "simply", "kind of", "seems", "perhaps".
- Never restate the label or the rating, and never open with a verdict word ("Textbook.", "Solid.", "Bold move.").
- Present tense. No puns, rhetorical questions, exclamation marks, dashes or semicolons.`;

/** What a card holds, per format: the long one is read at leisure, the short one in two seconds. */
function formatRules(format: Format): string {
  const caps = textCaps(format);
  const label = `- Label: the move's name in Title Case, at most ${caps.moveLabel} characters. When the move is a line, use the character's own words from it ("Barry Allen", "Secret Service"); otherwise a nickname for the action ("Whole Wallet", "Goes In Alone"). Never a sentence, and never an abstract noun such as Revelation, Confrontation, Deadline or Strategy.`;
  const motif = `- Motif: the chess idea the move embodies, as a one to three word chip in Title Case, at most ${caps.motif} characters (Sacrifice, Zwischenzug, Quiet Move, Check, Fork, Pin, Gambit, Decoy, Deflection, Prophylaxis, Blockade, Desperado, Overextension). Most moves have one: a threat is Check, giving something up is a Sacrifice, an unexpected reply that ignores the threat is a Zwischenzug. Leave it null only when none fits.`;
  if (format === 'short') {
    return `Format: a short-form vertical video. Viewers swipe away the moment it drags, so the cards come often and each is read in about two seconds.
${label}
- Breakdown: one short sentence of three to ten words, at most 60 characters (never over ${caps.explanation}). It is the payoff: how the other side takes the move, or what it does to the game ("The forced mate disappears.", "Checking him now feels rude."). Never describe the move again: the label and the frozen frame already show it. Chess terms are welcome when they are short (tempo, mate, a free piece), never a lecture. Only the first card may add a second short sentence, to set the game up.
- Best move: a two to five word command in Title Case, at most ${caps.bestMove} characters. It is something this character would do, given who they are and what they want, and it may be playful. Never the same best move twice in a scene.
${motif}`;
  }
  return `Format: a long-form movie-scene breakdown. The card is read during a freeze, so every field is short.
${label}
- Breakdown: exactly two sentences, about 25 to 30 words, at most ${caps.explanation} characters. Sentence one: what the character visibly does. Sentence two: the verdict in chess terms, what the move does to the game: a mate appears, speeds up or disappears; the attack stalls; tempo, material or the initiative changes hands. One verdict, committed: no "but", "though" or "while" weighing both sides. Name the character in the first sentence. Quote dialogue only when the words are the move, and then only a few of them.
- Best move: a two to four word command in Title Case, at most ${caps.bestMove} characters. It is something this character would do, given who they are and what they want: a schemer schemes better, a hunter hunts better. Never the same best move twice in a scene.
${motif}`;
}

/** Role, rubric, rules, voice and examples. Identical for every call on a clip, so it caches. */
export function systemPrompt(style: StyleCorpus, format: Format): string {
  const noBest = [...NO_BEST_MOVE].join(', ');
  const short = format === 'short';
  const examples = style.examples
    .map((e) =>
      [
        `Scene: ${e.context}`,
        `Rating: ${e.classification}`,
        `Label: ${e.moveLabel}`,
        `Breakdown: ${(short && e.shortExplanation) || e.explanation}`,
        `Best move: ${e.bestMove ?? '(none)'}`,
        `Motif: ${e.motif ?? '(none)'}`,
      ].join('\n'),
    )
    .join('\n\n');

  return `You write move annotations for "Analysed Like Chess" videos. A film scene is treated like a chess game: at each key decision the video freezes, and a card rates the character's move with a chess annotation, says what it did, and suggests a better move.

Ratings (use exactly these):
${CLASSIFICATIONS.map((c) => `- ${c}: the character ${RUBRIC[c]}`).join('\n')}

Rules:
- Judge each move on what the character could know at that moment, unless hindsight is the joke.
- A best move must be something the character could plausibly do with what they knew then.
- ${noBest} moves never get a best move: leave it null.
- Book is only for the scene's opening, the first ${FORMAT_RULES[format].bookWindowSec} seconds. After that, rate a textbook move good.
- Rate each move by what it does to the scene, and commit. The move that turns the scene is brilliant, great or a blunder, not good or an inaccuracy. A scene with a turn has at least one move from brilliant, great or best and at least one from mistake, miss or blunder.
- Use the middle ratings (excellent, good, inaccuracy) only for moves that change little. Do not make every move a blunder either.${
    short
      ? '\n- A short lives on clear verdicts: at most one card in four is book, good, excellent or inaccuracy; the rest are a clear win (brilliant, great, best) or a clear error (mistake, miss, blunder). A slip that hands the other side something is a mistake or a miss, not an inaccuracy.'
      : ''
  }
- Credit moves only to the cast listed with the timeline.

${formatRules(format)}

${writingRules}

Voice:
${(short && style.shortVoice) || style.voice}

Examples of the voice (from other scenes):

${examples}`;
}

/** About one move per `secondsPerMove`, never fewer than one. */
export const targetMoveCount = (durationSec: number, secondsPerMove: number) =>
  Math.max(1, Math.round(durationSec / secondsPerMove));

export function decisionPointsTask(target: number, format: Format): string {
  return `Task: find every moment in this scene where a character makes a choice with real alternatives, spoken or acted. Over-generate on purpose: list about ${target * 2} candidates (more if the scene is dense), because a later pass picks the best ${target} and the rest move the evaluation bar between cards.

For each candidate give the actor, what they did, the alternatives open to them, and the evidence:
- spoken choices: moveLine is the utterance the move is said in and its last two to five words, copied exactly: the video freezes right after them, before anyone answers. A move is one line, so the reply to it is a separate candidate, and a long utterance can hold several moves. evidenceUtteranceIds are the utterances that show the choice, in order; visualTimeSec null.
- visual choices: visualTimeSec, the moment the action happens; moveLine null; utterance ids only if dialogue is part of it.${
    format === 'short'
      ? `

This is a short: cover the scene's very first exchange, and in a rapid back-and-forth (one-word lines, a question repeated) list the line that pushes the argument furthest.`
      : ''
  }`;
}

export function annotationTask(candidates: Candidate[], target: number, format: Format): string {
  const short = format === 'short';
  return `Candidates found in the scene:
${JSON.stringify(candidates, null, 1)}

Task: pick the final ${target} moves (fewer only if the scene cannot support that many), spread across the scene's arc from its opening exchange to its last line and at least ${FORMAT_RULES[format].minCardGapSec} seconds apart, and annotate each in the voice shown above: rating, label, breakdown, best move (null where the rules say so), motif and your confidence. Prefer moves an audience would argue about, and give both sides moves when both make choices. Use each candidate at most once.${
    short ? ' The first card comes from the scene\'s first exchange, in its opening seconds: it is the hook that keeps viewers watching.' : ''
  }

Also name the scene's protagonist, the character the audience follows, who plays White, and their allies: anyone on the protagonist's side (a friend, a partner, a crew member), who plays White too. Leave the protagonist null if no one clearly stands out.

Before answering, check every card against the rules:
- Does the rating commit? The scene's turning points are brilliant, great or blunder.
${
  short
    ? `- Is the breakdown one short sentence (two only on the first card) that gives the payoff without describing the move again?`
    : `- Is the second sentence a chess verdict (mate, attack, tempo, initiative, material) with no "but", "though" or "while"?`
}
- Is the label the character's own words or a short nickname, not an abstract noun?
- Does the move have a motif if any chess idea fits?
- Is the best move something this character would do, and different from every other card's?
- Is the first move from the opening exchange?`;
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

export function evaluationTask(items: EvaluationItem[], format: Format, fixedStart?: Eval): string {
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
- Size follows the rating. From a roughly level position, a card typically moves the bar about this far for the player who moved: inaccuracy 0.5 to 1 pawn; excellent or good about 1; mistake about 2; great, best or miss 2.5 to 3.5; blunder or brilliant 3 or more, or a mate. Far from level each pawn moves the bar less, so go bigger there.
- Let the bar travel. Its swings are the story: a turning point moves it by whole pawns, not tenths, and a scene with a clear winner ends well past a clear edge. A bar that stays near level tells no story.
${
    format === 'short'
      ? '- Keep the game alive until the last card: stay within about ±5 pawns and out of mate before it, so every card can still move the bar visibly. The cards do the swinging.\n'
      : ''
  }- Each value is the bar right after that change. A card carries its whole swing at the card itself, never on the beat after it: the viewer reads the rating and sees the bar move together.
- Beats tell the story between cards in small steps: most carry the last card's direction a little further (the threat sinks in, the lie holds), and some lean toward the turn the next card makes. A beat never undoes the card before it.
- Beats are nudges, smaller than any card (${
    format === 'short' ? 'about 0.3 to 1 pawn; in a quick back-and-forth they tick the bar several times in a row' : 'a few tenths of a pawn'
  }), and never start or end a mate.
- Where a card's breakdown mentions the bar or the mate, match it.
- End where the scene ends: the last value is the result. A clear winner ends past ±3 or in a mate; a scene nobody wins ends level, at 0.0.
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
