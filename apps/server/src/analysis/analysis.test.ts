import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CUT_CLEARANCE_FRAMES,
  FREEZE_AFTER_SPEECH_SEC,
  NO_BEST_MOVE,
  ProjectSchema,
  RegenerateResultSchema,
  type Project,
} from '@als/schema';
import { defaultTheme } from '@als/theme/themes';
import { makeTestApp, DIALOGUE_RECORDING } from '../test-helpers.ts';
import { parseScribe } from './providers/elevenlabs.ts';
import { parseNotes } from './providers/gemini.ts';
import { snapMoves } from './snap-moves.ts';
import { castNames, timelineText } from './timeline-text.ts';

const recorded = async (name: string) => JSON.parse(await readFile(join(DIALOGUE_RECORDING, `${name}.json`), 'utf8'));
const DIALOGUE = new URL('../../../../fixtures/dialogue/source.mp4', import.meta.url);

describe('parseScribe', () => {
  it('turns the word list into words, utterances and sound events', async () => {
    const transcript = parseScribe(await recorded('elevenlabs'));
    expect(transcript.utterances).toHaveLength(8);
    expect(transcript.utterances.map((u) => u.speaker).join('')).toBe('ABABABAB');
    expect(transcript.utterances[0]).toMatchObject({ id: 'u1', text: expect.stringMatching(/^Blue, this place/) });
    expect(transcript.events).toEqual([expect.objectContaining({ text: '(creaking)' })]);
    for (const u of transcript.utterances) {
      const [first, last] = u.wordRange;
      expect(transcript.words[first]!.start).toBe(u.start);
      expect(transcript.words[last]!.end).toBe(u.end);
    }
  });

  it('starts a new utterance after a long pause from the same speaker', () => {
    const w = (text: string, start: number, end: number) => ({ text, type: 'word', start, end, speaker_id: 's0' });
    const t = parseScribe({ words: [w('One', 0, 0.4), w('two', 0.5, 0.9), w('Later', 3, 3.4)] });
    expect(t.utterances.map((u) => u.text)).toEqual(['One two', 'Later']);
  });
});

describe('parseNotes', () => {
  it('clamps notes to the clip, names who is on screen, and sorts them', () => {
    const notes = parseNotes(
      {
        notes: [
          { startSec: 8, endSec: 12, onScreen: [], text: 'Late' },
          { startSec: -1, endSec: 2, onScreen: ['Red'], text: 'Early' },
        ],
      },
      10,
    );
    expect(notes).toEqual([
      { start: 0, end: 2, text: '[Red] Early' },
      { start: 8, end: 10, text: 'Late' },
    ]);
  });
});

/** The dialogue fixture as analysis sees it, without running ffmpeg. */
async function dialogueProject(): Promise<Project> {
  const transcript = parseScribe(await recorded('elevenlabs'));
  const gemini = await recorded('gemini');
  return ProjectSchema.parse({
    id: 'dialogue',
    version: 1,
    createdAt: '2026-10-10T00:00:00.000Z',
    source: { file: 'source.mp4', proxy: 'proxy.mp4', fps: 24, durationSec: 30.78, width: 1280, height: 720, hasAudio: true },
    context: {
      characters: [
        { id: 'c-red', name: 'Red', speakerLabels: ['A'] },
        { id: 'c-blue', name: 'Blue', speakerLabels: ['B'] },
      ],
    },
    transcript,
    shots: [0, 4.5, 9, 13.5, 18, 22.5, 27].map((start, i, all) => ({ start, end: all[i + 1] ?? 30.78 })),
    sceneNotes: parseNotes(gemini.raw, 30.78),
    moments: [],
    themeId: 'default',
    ingest: { status: 'done', stages: [] },
    analysis: { status: 'idle', stages: [], models: {} },
  });
}

describe('timelineText', () => {
  it('merges cuts, scene notes, sounds and named dialogue in time order', async () => {
    const text = timelineText(await dialogueProject());
    expect(text).toMatch(/^CLIP: 0:30\.8 long\./);
    expect(text).toContain('CAST: Red, Blue');
    expect(text).toMatch(/\[1\.05-\d+\.\d+\] u1 Red: "Blue, this place gives me the creeps/);
    expect(text).toContain('SOUND: (creaking)');
    expect(text).toContain('CUT to shot 2');
    const times = [...text.matchAll(/^\[(\d+\.\d+)/gm)].map((m) => Number(m[1]));
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it('lists unnamed speakers in the cast so their moves can be credited', async () => {
    const project = await dialogueProject();
    project.context.characters = [];
    expect(castNames(project)).toEqual(['Speaker A', 'Speaker B']);
  });
});

describe('snapMoves', () => {
  const candidates = [
    { id: 'c1', actor: 'Red', kind: 'spoken' as const, action: 'Splits up', alternatives: [], evidenceUtteranceIds: ['u1'], visualTimeSec: null },
    { id: 'c2', actor: 'Blue', kind: 'visual' as const, action: 'Lights on', alternatives: [], evidenceUtteranceIds: [], visualTimeSec: 22.51 },
    { id: 'c3', actor: 'Blue', kind: 'spoken' as const, action: 'Locks door', alternatives: [], evidenceUtteranceIds: ['u4'], visualTimeSec: null },
  ];
  const move = (candidateId: string, classification: 'mistake' | 'great', confidence = 0.8) => ({
    candidateId,
    classification,
    moveLabel: ' Label ',
    explanation: 'Why.',
    bestMove: 'Do better.',
    confidence,
  });

  it('freezes spoken moves just after the last word, in its shot, clear of cuts', async () => {
    const project = await dialogueProject();
    const { moments } = snapMoves(project, candidates, [move('c1', 'mistake')], defaultTheme);
    const lastWord = project.transcript!.words[project.transcript!.utterances[0]!.wordRange[1]]!;
    const [m] = moments;
    expect(m!.sourceTime).toBeGreaterThan(lastWord.end);
    expect(m!.sourceTime).toBeLessThanOrEqual(lastWord.end + FREEZE_AFTER_SPEECH_SEC + 1 / 24);
    expect(m).toMatchObject({ actorId: 'c-red', origin: 'ai', status: 'draft', moveLabel: 'Label', evidence: { utteranceIds: ['u1'] } });
  });

  it('places visual moves on a clean frame, never beside a cut', async () => {
    const project = await dialogueProject();
    const { moments } = snapMoves(project, candidates, [move('c2', 'great')], defaultTheme);
    const frame = Math.round(moments[0]!.sourceTime * 24);
    expect(frame).toBeGreaterThanOrEqual(Math.round(22.5 * 24) + CUT_CLEARANCE_FRAMES);
  });

  it('never gives a best move to ratings that do not have one', async () => {
    const { moments } = snapMoves(await dialogueProject(), candidates, [move('c2', 'great')], defaultTheme);
    expect(NO_BEST_MOVE.has(moments[0]!.classification)).toBe(true);
    expect(moments[0]!.bestMove).toBeUndefined();
  });

  it("keeps the creator's moves and drops drafts too close to them", async () => {
    const project = await dialogueProject();
    const first = snapMoves(project, candidates, [move('c1', 'mistake')], defaultTheme).moments[0]!;
    project.moments = [{ ...first, id: 'mine', origin: 'user', moveLabel: 'Mine' }];
    const { moments, dropped } = snapMoves(project, candidates, [move('c1', 'mistake'), move('c3', 'great')], defaultTheme);
    expect(moments.map((m) => m.id)).toEqual(['mine', 'ai-c3-2']);
    expect(dropped).toEqual([expect.objectContaining({ reason: 'too close to another move' })]);
  });
});

// End to end: upload the dialogue clip, real ffmpeg ingest, then analysis on its own
// with recorded provider responses.
describe('analysis pipeline', () => {
  let root: string;
  let env: Awaited<ReturnType<typeof makeTestApp>>;
  let project: Project;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'als-analysis-'));
    env = await makeTestApp(root, { autoAnalyze: true });
    const res = await env.app.request('/api/projects?name=dialogue.mp4', { method: 'POST', body: await readFile(DIALOGUE) });
    expect(res.status).toBe(201);
    const { id } = ProjectSchema.parse(await res.json());
    await env.queue.whenIdle();
    await new Promise((r) => setTimeout(r, 50));
    await env.analysis.queue.whenIdle();
    project = await env.store.read(id);
  }, 120_000);

  afterAll(async () => {
    await env.analysis.queue.whenIdle();
    await rm(root, { recursive: true, force: true });
  });

  it('goes from upload to editable drafts with no manual steps', () => {
    expect(project.analysis.status).toBe('done');
    expect(project.analysis.stages.map((s) => [s.name, s.status])).toEqual([
      ['transcribe', 'done'],
      ['describe', 'done'],
      ['speakers', 'done'],
      ['decisions', 'done'],
      ['annotate', 'done'],
      ['snap', 'done'],
    ]);
    expect(project.moments).toHaveLength(3);
    expect(project.moments.every((m) => m.origin === 'ai' && m.status === 'draft')).toBe(true);
  });

  it('names the speakers', () => {
    expect(project.context.characters.map((c) => [c.name, c.speakerLabels])).toEqual([
      ['Red', ['A']],
      ['Blue', ['B']],
    ]);
    expect(project.moments.map((m) => project.context.characters.find((c) => c.id === m.actorId)?.name)).toEqual(['Red', 'Blue', 'Red']);
  });

  it("cites only evidence that exists in the transcript", () => {
    const ids = new Set(project.transcript!.utterances.map((u) => u.id));
    for (const m of project.moments) {
      expect(m.evidence.utteranceIds.length).toBeGreaterThan(0);
      for (const id of m.evidence.utteranceIds) expect(ids.has(id)).toBe(true);
    }
  });

  it('never freezes within 2 frames of a cut', () => {
    const fps = project.source.fps;
    const cuts = project.shots!.slice(1).map((s) => Math.round(s.start * fps));
    expect(cuts.length).toBeGreaterThan(4);
    for (const m of project.moments) {
      const frame = Math.round(m.sourceTime * fps);
      for (const cut of cuts) {
        // Frames cut-2 and cut-1 end the outgoing shot; cut and cut+1 start the next.
        expect(frame < cut - CUT_CLEARANCE_FRAMES || frame >= cut + CUT_CLEARANCE_FRAMES).toBe(true);
      }
    }
  });

  it('shows tokens and cost per stage', () => {
    const byName = Object.fromEntries(project.analysis.stages.map((s) => [s.name, s]));
    expect(byName.transcribe!.usage?.audioSec).toBeCloseTo(30.8, 0);
    for (const name of ['describe', 'speakers', 'decisions', 'annotate']) {
      expect(byName[name]!.usage?.outputTokens).toBeGreaterThan(0);
      expect(byName[name]!.model).toBeTruthy();
    }
    for (const name of ['transcribe', 'describe', 'speakers', 'decisions', 'annotate']) {
      expect(byName[name]!.costUsd).toBeGreaterThan(0);
    }
    const sum = project.analysis.stages.reduce((s, x) => s + (x.costUsd ?? 0), 0);
    expect(project.analysis.costUsd).toBeCloseTo(sum, 5);
  });

  it('keeps the track it replaced in history', async () => {
    expect((await readdir(env.store.file(project.id, 'history'))).length).toBeGreaterThan(0);
  });

  it('re-running the Analyst skips Stages 1 and 2 and keeps approved moves', async () => {
    // Approve one move through the editor's save path.
    const approved = project.moments[1]!;
    const save = await env.app.request(`/api/projects/${project.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        version: project.version,
        moments: project.moments.map((m) => (m.id === approved.id ? { ...m, status: 'approved', moveLabel: 'Approved edit' } : m)),
        characters: project.context.characters,
      }),
    });
    expect(save.status).toBe(200);

    const res = await env.app.request(`/api/projects/${project.id}/analyze`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rerun: 'analyst' }),
    });
    expect(res.status).toBe(202);
    await env.analysis.queue.whenIdle();
    const rerun = await env.store.read(project.id);
    expect(rerun.analysis.stages.map((s) => [s.name, s.status])).toEqual([
      ['transcribe', 'cached'],
      ['describe', 'cached'],
      ['speakers', 'skipped'],
      ['decisions', 'done'],
      ['annotate', 'done'],
      ['snap', 'done'],
    ]);
    expect(rerun.moments.find((m) => m.id === approved.id)?.moveLabel).toBe('Approved edit');
    expect(rerun.moments).toHaveLength(3);
    // Cached stages cost nothing on this run.
    const cached = rerun.analysis.stages.filter((s) => s.status === 'cached');
    expect(cached.every((s) => s.costUsd === undefined)).toBe(true);
  });

  it('regenerates one moment as a proposal, without saving the project', async () => {
    const before = await env.store.read(project.id);
    const res = await env.app.request(`/api/projects/${project.id}/regenerate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ moment: before.moments[0], instruction: 'funnier' }),
    });
    expect(res.status).toBe(200);
    const result = RegenerateResultSchema.parse(await res.json());
    expect(result.draft.moveLabel).toBeTruthy();
    expect(result.costUsd).toBeGreaterThan(0);
    expect((await env.store.read(project.id)).version).toBe(before.version);
    const usage = await (await env.app.request(`/api/projects/${project.id}/usage`)).json();
    expect(usage).toEqual({ regenerate: { count: 1, costUsd: result.costUsd } });
  });

  it('refuses to analyse without API keys and says which', async () => {
    const bare = await makeTestApp(root, { replayDir: undefined, keys: {} });
    const res = await bare.app.request(`/api/projects/${project.id}/analyze`, { method: 'POST' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: expect.stringMatching(/ELEVENLABS_API_KEY.*GEMINI_API_KEY.*ANTHROPIC_API_KEY/) });
  });
});
