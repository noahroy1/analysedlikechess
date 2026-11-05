// Copies the sample clip and the user's chess sounds into public/ (gitignored) and writes the sound bank.
// The bank mirrors SoundLibrary (apps/server/src/media/sounds.ts): `<id>.<ext>`, lengths from ffprobe.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const clip = resolve(process.env.TRIAL_CLIP ?? join(root, 'fixtures/sample/source.mp4'));
const project = resolve(process.env.TRIAL_PROJECT ?? join(root, 'fixtures/sample/project.json'));
const soundsDir = resolve(process.env.SOUNDS_DIR ?? join(root, 'media/sounds'));
const SOUND_FILE = /^([a-z0-9-]+)\.(wav|mp3|ogg|m4a|aac|flac)$/;

const media = join(here, 'public/media');
const sounds = join(here, 'public/sounds');
rmSync(media, { recursive: true, force: true });
rmSync(sounds, { recursive: true, force: true });
mkdirSync(media, { recursive: true });
mkdirSync(sounds, { recursive: true });

// The clip's own audio is stripped (TRIAL_KEEP_AUDIO=1 keeps it), as sound-checks.mjs does: otherwise its
// Web Audio buffers start on nearly every frame and the sound cues can't be told apart from them.
if (process.env.TRIAL_KEEP_AUDIO) copyFileSync(clip, join(media, 'source.mp4'));
else execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', clip, '-an', '-c', 'copy', join(media, 'source.mp4')]);
copyFileSync(project, join(media, 'project.json'));
console.log(`clip ${clip}\nproject ${project}`);

const bank = {};
for (const file of readdirSync(soundsDir).sort()) {
  const id = SOUND_FILE.exec(file)?.[1];
  if (!id || bank[id]) continue;
  const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', join(soundsDir, file)], { encoding: 'utf8' });
  const durationSec = Number(out.trim());
  if (!(durationSec > 0)) continue;
  copyFileSync(join(soundsDir, file), join(sounds, file));
  bank[id] = { src: `sounds/${file}`, durationSec };
}
writeFileSync(join(sounds, 'bank.json'), `${JSON.stringify(bank, null, 2)}\n`);
console.log(`${Object.keys(bank).length} sounds from ${soundsDir}`);
