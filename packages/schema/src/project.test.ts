import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CLASSIFICATIONS,
  MomentSchema,
  ProjectSchema,
  momentWarnings,
  textCaps,
  toJsonSchema,
  type Moment,
  type Project,
} from './index.ts';

const fixtureUrl = new URL('../../../fixtures/sample/project.json', import.meta.url);
const loadFixture = (): Project => JSON.parse(readFileSync(fixtureUrl, 'utf8'));

/** Fixture with its moments replaced, for testing track rules in isolation. */
const withMoments = (edit: (moments: Moment[]) => Moment[]): unknown => {
  const project = loadFixture();
  return { ...project, moments: edit(project.moments) };
};

const messages = (input: unknown): string[] => {
  const result = ProjectSchema.safeParse(input);
  return result.success ? [] : result.error.issues.map((i) => i.message);
};

describe('fixture', () => {
  it('validates against ProjectSchema', () => {
    expect(() => ProjectSchema.parse(loadFixture())).not.toThrow();
  });

  it('has three moments and no soft warnings', () => {
    const project = ProjectSchema.parse(loadFixture());
    expect(project.moments).toHaveLength(3);
    for (const moment of project.moments) expect(momentWarnings(moment, 'long')).toEqual([]);
  });
});

describe('classifications', () => {
  it('lists all ten ratings from brilliant to blunder', () => {
    expect(CLASSIFICATIONS).toHaveLength(10);
    expect(CLASSIFICATIONS[0]).toBe('brilliant');
    expect(CLASSIFICATIONS[9]).toBe('blunder');
  });
});

describe('moment spacing', () => {
  it('accepts moments exactly 0.5 s apart', () => {
    const input = withMoments(([a, b, c]) => [a!, { ...b!, sourceTime: a!.sourceTime + 0.5 }, c!]);
    expect(messages(input)).toEqual([]);
  });

  it('rejects moments closer than 0.5 s', () => {
    const input = withMoments(([a, b, c]) => [a!, { ...b!, sourceTime: a!.sourceTime + 0.49 }, c!]);
    expect(messages(input)).toEqual([expect.stringMatching(/minimum is 0.5 s/)]);
  });

  it('rejects two moments at the same time', () => {
    const input = withMoments(([a, b, c]) => [a!, { ...b!, sourceTime: a!.sourceTime }, c!]);
    expect(messages(input)).toEqual([expect.stringMatching(/minimum is 0.5 s/)]);
  });

  it('rejects unsorted moments', () => {
    const input = withMoments(([a, b, c]) => [b!, a!, c!]);
    expect(messages(input)).toEqual(['moments must be sorted by sourceTime']);
  });

  it('accepts a moment at 0 s and one at the very end', () => {
    const input = withMoments(([a, b]) => [{ ...a!, sourceTime: 0 }, { ...b!, sourceTime: 10 }]);
    expect(messages(input)).toEqual([]);
  });

  it('rejects a moment past the end of the clip', () => {
    const input = withMoments(([a]) => [{ ...a!, sourceTime: 10.01 }]);
    expect(messages(input)).toEqual([expect.stringMatching(/past the end of the clip/)]);
  });
});

describe('references', () => {
  it('rejects an actorId that is not a character', () => {
    const input = withMoments(([a]) => [{ ...a!, actorId: 'c-ghost' }]);
    expect(messages(input)).toEqual(['actorId "c-ghost" is not a character']);
  });

  it('rejects evidence that is not in the transcript', () => {
    const input = withMoments(([a]) => [{ ...a!, evidence: { utteranceIds: ['u1', 'u99'] } }]);
    expect(messages(input)).toEqual(['evidence utterance "u99" is not in the transcript']);
  });

  it('rejects evidence when there is no transcript', () => {
    const { transcript: _, ...project } = loadFixture();
    expect(messages(project)).toHaveLength(3);
  });

  it('rejects duplicate moment ids', () => {
    const input = withMoments(([a, b]) => [a!, { ...b!, id: a!.id }]);
    expect(messages(input)).toEqual(['duplicate moment id "m1"']);
  });

  it('rejects a speaker label shared by two characters', () => {
    const project = loadFixture();
    project.context.characters[1]!.speakerLabels.push('A');
    expect(messages(project)).toEqual([expect.stringMatching(/speaker label "A"/)]);
  });

  it('rejects a wordRange past the last word', () => {
    const project = loadFixture();
    project.transcript!.utterances[2]!.wordRange = [9, 13];
    expect(messages(project)).toEqual([expect.stringMatching(/past the last word/)]);
  });
});

describe('MomentSchema', () => {
  const moment = (): Moment => loadFixture().moments[0]!;

  it('requires x and y for a custom anchor', () => {
    const result = MomentSchema.safeParse({ ...moment(), card: { anchor: 'custom', scale: 1 } });
    expect(result.success).toBe(false);
  });

  it('keeps custom positions inside the frame', () => {
    const card = { anchor: 'custom', x: 1.2, y: 0.5, scale: 1 };
    expect(MomentSchema.safeParse({ ...moment(), card }).success).toBe(false);
  });

  it('rejects an unknown classification', () => {
    expect(MomentSchema.safeParse({ ...moment(), classification: 'genius' }).success).toBe(false);
  });

  it('accepts a blank user moment', () => {
    const blank = { ...moment(), moveLabel: '', explanation: '', origin: 'user', status: 'draft' };
    delete blank.bestMove;
    delete blank.confidence;
    delete blank.actorId;
    expect(MomentSchema.safeParse(blank).success).toBe(true);
  });
});

describe('momentWarnings', () => {
  const moment = (): Moment => loadFixture().moments[0]!;

  it('warns when text is over its cap but the moment still validates', () => {
    const cap = textCaps('long').explanation;
    const long = { ...moment(), explanation: 'x'.repeat(cap + 1) };
    expect(MomentSchema.safeParse(long).success).toBe(true);
    expect(momentWarnings(long, 'long')).toEqual([
      { field: 'explanation', message: `explanation is ${cap + 1} characters, over the cap of ${cap}` },
    ]);
  });

  it('holds short-form breakdowns to a shorter cap', () => {
    const text = { ...moment(), explanation: 'x'.repeat(textCaps('short').explanation + 1) };
    expect(momentWarnings(text, 'long')).toEqual([]);
    expect(momentWarnings(text, 'short').map((w) => w.field)).toEqual(['explanation']);
  });

  it('warns about a bestMove on a best or brilliant rating', () => {
    expect(momentWarnings({ ...moment(), classification: 'best' }, 'long')).toEqual([
      expect.objectContaining({ field: 'bestMove' }),
    ]);
  });
});

describe('toJsonSchema', () => {
  it('exports the moment schema with every field', () => {
    const json = toJsonSchema(MomentSchema) as { properties: Record<string, unknown>; required: string[] };
    expect(Object.keys(json.properties)).toEqual(Object.keys(MomentSchema.shape));
    expect(json.required).toContain('classification');
    expect(json.required).not.toContain('bestMove');
  });
});

describe('demo moments', () => {
  it('are valid moments within the text caps', () => {
    const url = new URL('../../../fixtures/demo/doakes-moments.json', import.meta.url);
    const demo = JSON.parse(readFileSync(url, 'utf8')) as { moments: unknown[] };
    for (const raw of demo.moments) {
      const moment = MomentSchema.parse(raw);
      expect(momentWarnings(moment, 'long')).toEqual([]);
    }
  });
});
