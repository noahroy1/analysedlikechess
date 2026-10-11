// Times the phases of a hold in a reference clip (freeze, dim, badge, card, type-out, exit)
// from frame-to-frame change in the whole picture and in a crop around the card.
// usage: node scripts/ref/hold-phases.mjs <clip> <crop w:h:x:y> [fps]
// Prints one row per quarter second (at 60 fps; pass fps otherwise), two characters per frame:
//   first, the whole picture: P = playing, o = something small moved (badge, dim), . = still
//   second, the crop:         C = big change (card in, new line), c = small (a word fading in), . = still
// Used on media/creator-ref (Oct 12, 2026) to measure the creator's timing; needs system ffmpeg.
import { execFileSync } from 'node:child_process';

const [file, crop, fpsArg] = process.argv.slice(2);
if (!file || !crop) throw new Error('usage: node scripts/ref/hold-phases.mjs <clip> <crop w:h:x:y> [fps]');
const fps = Number(fpsArg ?? 60);
const W = 64;
const H = 36;
const grab = (vf) =>
  execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-vf', `${vf}scale=${W}:${H},format=gray`, '-f', 'rawvideo', '-'], { maxBuffer: 1 << 30 });
const change = (buf) => {
  const n = buf.length / (W * H);
  const out = [];
  for (let i = 1; i < n; i++) {
    let d = 0;
    for (let j = 0; j < W * H; j++) d += Math.abs(buf[i * W * H + j] - buf[(i - 1) * W * H + j]);
    out.push(d / (W * H));
  }
  return out;
};
const whole = change(grab(''));
const card = change(grab(`crop=${crop},`));
const perRow = Math.round(fps / 4);
let line = '';
for (let i = 0; i < whole.length; i++) {
  if (i % perRow === 0) line += `\n${((i + 1) / fps).toFixed(2).padStart(6)} `;
  line += `${whole[i] > 1.5 ? 'P' : whole[i] > 0.05 ? 'o' : '.'}${card[i] > 0.3 ? 'C' : card[i] > 0.02 ? 'c' : '.'} `;
}
console.log(line);
