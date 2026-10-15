// Render checks against a running `pnpm dev`, in headless Chrome.
// usage: node scripts/browser/render-checks.mjs <scratchDir> <projectsDir> <projectId> [--reuse]
// (--reuse compares the newest finished render instead of making a new one)
// Renders the project from the editor's Render menu, then compares three holds (and the game review, if any)
// in the MP4 with the same frames drawn by the Player. The Player plays the
// 720p proxy and draws text at the page's scale, so frames are compared at its
// size after a slight blur (sharp text edges otherwise dominate), with a
// control showing the comparison tells a card from no card.
import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { launch, sleep } from './cdp.mjs';

const [S, projectsDir, projectId, flag] = process.argv.slice(2);
const reuse = flag === '--reuse';
const P = 'window.__alsPlayer';
const E = 'window.__alsEditor';
const result = (name, ok, detail = '') => console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);

/** PSNR (dB) of `b` against `a`, with `b` scaled to `a`'s size, both in RGB and lightly blurred. */
function psnrOf(a, b, width, height) {
  const filter = `[0]format=rgb24,gblur=sigma=1.5[a];[1]scale=${width}:${height}:flags=lanczos,format=rgb24,gblur=sigma=1.5[b];[a][b]psnr`;
  const run = spawnSync('ffmpeg', ['-v', 'info', '-i', a, '-i', b, '-lavfi', filter, '-f', 'null', '-'], { encoding: 'utf8' });
  const match = /average:([\d.]+|inf)/.exec(run.stderr);
  if (!match) throw new Error(`ffmpeg psnr failed: ${run.stderr.slice(-500)}`);
  return match[1] === 'inf' ? Infinity : Number(match[1]);
}

const page = await launch({ profile: `${S}/chrome-render`, width: 1680, height: 1150 });
try {
  await page.goto(`http://localhost:5173/#/projects/${projectId}`);
  await page.waitFor(`!!${P} && !!${E}`);
  await sleep(1500);
  await page.eval(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Preview')?.click()`);

  const clickText = (text) => page.eval(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(text)})?.click() ?? false`);
  if (!reuse) {
    // Render from the menu, as the user would.
    await clickText('Render');
    await page.waitFor(`!!document.querySelector('[data-testid=render-menu]')`);
    const before = await page.eval(`document.querySelectorAll('[data-testid=render-row]').length`);
    await page.eval(`document.querySelector('[data-testid=render-start]').click()`);
    await page.waitFor(`document.querySelectorAll('[data-testid=render-row]').length > ${before}`, 20000);

    let sawProgress = false;
    const started = Date.now();
    for (;;) {
      const state = JSON.parse(
        await page.eval(`JSON.stringify({ status: document.querySelector('[data-testid=render-row]')?.dataset.status, label: [...document.querySelectorAll('header button')].map((b) => b.textContent).find((t) => t.startsWith('Rendering')) ?? null })`),
      );
      if (state.label && /Rendering [1-9]\d?%/.test(state.label)) sawProgress = true;
      if (state.status === 'done' || state.status === 'failed' || state.status === 'cancelled') {
        result('the render finishes', state.status === 'done', `${state.status} after ${Math.round((Date.now() - started) / 1000)} s`);
        if (state.status !== 'done') throw new Error('render did not finish');
        break;
      }
      if (Date.now() - started > 20 * 60_000) throw new Error('render timed out');
      await sleep(1000);
    }
    result('the header shows live progress', sawProgress);
    await page.waitFor(`[...document.querySelectorAll('[role=status]')].some((t) => t.textContent.startsWith('Render finished'))`, 5000).then(
      () => result('a toast announces the finished render', true),
      () => result('a toast announces the finished render', false),
    );
    // Close the menu so it does not cover the frame.
    await clickText('Render');
  }

  const renders = await page.eval(`fetch('/api/projects/${projectId}/renders').then((r) => r.json())`);
  const job = renders.find((r) => r.status === 'done');
  const mp4 = join(projectsDir, projectId, job.file);
  const project = await page.eval(`fetch('/api/projects/${projectId}').then((r) => r.json())`);
  result('the render is of the saved version', job.projectVersion === project.version, `v${job.projectVersion}, project at v${project.version}`);
  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_packets', '-show_entries', 'stream=nb_read_packets,width,height', '-of', 'json', mp4], { encoding: 'utf8' })).streams[0];
  result('the MP4 has every output frame', Number(probe.nb_read_packets) === job.frames, `${probe.nb_read_packets} frames, expected ${job.frames}`);
  result('the MP4 is the source size', probe.width === project.source.width && probe.height === project.source.height, `${probe.width}×${probe.height}`);

  // Three holds: first, middle and last. Each is checked in its reread, with the card complete.
  const holds = JSON.parse(await page.eval(`JSON.stringify([...document.querySelectorAll('[data-testid=hold-block]')].map((b) => ({ id: b.dataset.momentId, start: Number(b.dataset.outStart), frames: Number(b.dataset.frames) })))`));
  const picked = [...new Set([0, Math.floor(holds.length / 2), holds.length - 1])].map((i) => holds[i]);
  const { fps } = project.source;
  const cardOutSec = await page.eval(`${E}.getState().theme.timing.cardOutSec`);
  await page.eval(`document.head.insertAdjacentHTML('beforeend', '<style>[data-testid=edit-layer]{display:none!important}</style>')`);
  const grab = async (frame, name) => {
    await page.eval(`${P}.pause(); ${P}.seekTo(${frame})`);
    await sleep(900);
    // Measured after the seek: a paused hold selects its move, and the inspector's height can move the stage.
    const rect = JSON.parse(await page.eval(`JSON.stringify(document.querySelector('[data-testid=stage]').getBoundingClientRect())`));
    const clip = { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
    const preview = join(S, `render-${name}-preview.png`);
    const rendered = join(S, `render-${name}-mp4.png`);
    await page.screenshot(preview, clip);
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', mp4, '-vf', `select=eq(n\\,${frame})`, '-frames:v', '1', rendered]);
    return { preview, rendered, clip };
  };

  /** Compares the Player and the MP4 at `frame`, against a control frame of the MP4 without the overlay. */
  const compare = async (name, label, frame, controlFrame) => {
    const { preview, rendered, clip } = await grab(frame, name);
    const match = psnrOf(preview, rendered, clip.width, clip.height);
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', mp4, '-vf', `select=eq(n\\,${controlFrame})`, '-frames:v', '1', join(S, `render-${name}-control.png`)]);
    const control = psnrOf(preview, join(S, `render-${name}-control.png`), clip.width, clip.height);
    // Measured Oct 13: real footage 34 dB, fine synthetic detail 29-31 dB; controls 14-22 dB.
    result(`${label} matches the preview`, match >= 27 && match - control >= 8, `PSNR ${match.toFixed(1)} dB; without it ${control.toFixed(1)} dB; output frame ${frame}`);
    // Preview above, MP4 below, for looking at.
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', preview, '-i', rendered, '-filter_complex', `[1]scale=${clip.width}:${clip.height}[b];[0][b]vstack`, join(S, `render-${name}-compare.png`)]);
  };

  for (const [i, hold] of picked.entries()) {
    // Control: the MP4's last frame before the hold (same picture, no card or dim).
    await compare(`hold${i + 1}`, `hold ${i + 1} (${hold.id})`, hold.start + hold.frames - Math.ceil(cardOutSec * fps) - Math.round(fps), hold.start - 1);
  }
  // The game review, where the look has one, against the last frame before it.
  const review = JSON.parse(await page.eval(`JSON.stringify((() => { const b = document.querySelector('[data-testid=game-review-block]'); return b ? { start: +b.dataset.outStart, frames: +b.dataset.frames } : null; })())`));
  if (review) await compare('review', 'the game review', review.start + Math.round(fps), review.start - 1);
} finally {
  page.close();
}
