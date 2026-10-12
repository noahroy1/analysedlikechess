import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SoundBankSchema } from '@als/schema';
import { makeTestApp } from '../test-helpers.ts';
import { run } from './run.ts';
import { SoundLibrary } from './sounds.ts';

let root: string;
let dir: string;

const tone = (file: string, sec: number) =>
  run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${sec}`, '-ar', '48000', join(dir, file)]);

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'als-sounds-'));
  dir = join(root, 'sounds');
  await mkdir(dir);
  await tone('move-self.mp3', 0.15);
  await tone('typing-end.wav', 1.5);
  await tone('not-a-sound.wav', 0.2);
  await writeFile(join(dir, '.DS_Store'), 'x');
});

afterAll(() => rm(root, { recursive: true, force: true }));

describe('SoundLibrary', () => {
  it('lists the known sounds with their lengths, and nothing else', async () => {
    const bank = await new SoundLibrary(dir).bank();
    expect(Object.keys(bank).sort()).toEqual(['move-self', 'typing-end']);
    expect(bank['typing-end']).toEqual({ src: '/api/sounds/typing-end.wav', durationSec: expect.closeTo(1.5, 1) });
    expect(bank['move-self']!.durationSec).toBeGreaterThan(0.1);
  });

  it('is empty without a folder', async () => {
    expect(await new SoundLibrary(join(root, 'missing')).bank()).toEqual({});
  });

  it('serves only sound files', async () => {
    const { app } = await makeTestApp(root, {}, dir);
    const bank = SoundBankSchema.parse(await (await app.request('/api/sounds')).json());
    expect(bank['move-self']?.src).toBe('/api/sounds/move-self.mp3');
    const file = await app.request('/api/sounds/move-self.mp3');
    expect(file.status).toBe(200);
    expect((await file.arrayBuffer()).byteLength).toBeGreaterThan(0);
    expect((await app.request('/api/sounds/not-a-sound.wav')).status).toBe(404);
    expect((await app.request('/api/sounds/..%2Fsounds%2Fmove-self.mp3')).status).toBe(404);
  });
});
