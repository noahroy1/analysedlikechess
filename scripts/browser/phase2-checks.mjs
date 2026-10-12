// Phase 2 checks against a running `pnpm dev`, in headless Chrome (needs Google Chrome installed).
// usage: node scripts/browser/phase2-checks.mjs <scratchDir> <projectId> <fps> <outFrames> [allowedDarkFrames]
// Verifies: timeline blocks line up with holds, Review stops at every hold, Preview plays through,
// no black flashes, and the video is frozen through each hold.
import { launch, sleep } from './cdp.mjs';

const [S, projectId] = process.argv.slice(2);
const page = await launch({ profile: `${S}/chrome` });
const P = 'window.__alsPlayer';
const result = (name, ok, detail = '') => console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);

// Samples the visible video canvas every animation frame: player frame, brightness and a coarse hash.
const SAMPLER = `(() => {
  const small = document.createElement('canvas'); small.width = 32; small.height = 18;
  const ctx = small.getContext('2d', { willReadFrequently: true });
  window.__samples = [];
  const tick = () => {
    if (!window.__sampling) return;
    const frame = ${P}.getCurrentFrame();
    const visible = [...document.querySelectorAll('canvas')].filter((c) => c.offsetParent !== null && getComputedStyle(c).opacity !== '0' && c.width > 0);
    const top = visible.at(-1);
    let mean = -1, hash = 0;
    if (top) {
      ctx.drawImage(top, 0, 0, 32, 18);
      const d = ctx.getImageData(0, 0, 32, 18).data;
      let sum = 0;
      for (let i = 0; i < d.length; i += 4) { sum += d[i] + d[i + 1] + d[i + 2]; hash = (hash * 31 + d[i] + d[i + 1] * 7 + d[i + 2] * 13) >>> 0; }
      mean = sum / (d.length / 4) / 3;
    }
    const card = !!document.querySelector('.__remotion-player [data-moment-id]');
    window.__samples.push({ frame, mean: Math.round(mean), hash, card, playing: ${P}.isPlaying() });
    requestAnimationFrame(tick);
  };
  window.__sampling = true; requestAnimationFrame(tick);
})()`;

try {
  await page.goto(`http://localhost:5173/#/projects/${projectId}`);
  await page.waitFor(`!!${P}`);
  await sleep(1500);
  const blocks = JSON.parse(await page.eval(`JSON.stringify([...document.querySelectorAll('[data-testid=hold-block]')].map(b => ({ id: b.dataset.momentId, outStart: +b.dataset.outStart, frames: +b.dataset.frames })))`));
  const outFrames = await page.eval(`(() => { const t = document.querySelector('[data-testid=clock]').textContent; return t; })()`);
  console.log('holds', JSON.stringify(blocks), '| clock', outFrames);
  const fps = Number(process.argv[4] ?? 30);
  const stops = blocks.map((b) => b.outStart + Math.min(b.frames - 1, Math.ceil(0.25 * fps)));

  // 1. Timeline blocks line up with the holds the composition draws.
  {
    const errors = [];
    const total = Number(process.argv[5]);
    for (const b of blocks) {
      const rect = JSON.parse(await page.eval(`JSON.stringify(document.querySelector('[data-moment-id="${b.id}"][data-testid=hold-block]').getBoundingClientRect())`));
      const track = JSON.parse(await page.eval(`JSON.stringify(document.querySelector('[data-testid=timeline-track]').getBoundingClientRect())`));
      // Measured with the block: a page scrollbar coming or going in between would change the width.
      const framePx = track.width / total;
      const leftFrames = (rect.left - track.left) / framePx;
      const widthFrames = rect.width / framePx;
      if (Math.abs(leftFrames - b.outStart) > 1 || Math.abs(widthFrames - b.frames) > 1) errors.push(`${b.id}: block at ${leftFrames.toFixed(2)}+${widthFrames.toFixed(2)} vs hold ${b.outStart}+${b.frames}`);
      // The card is drawn exactly on the hold's frames, no earlier and no later.
      for (const [f, expected] of [[b.outStart - 1, false], [b.outStart, true], [b.outStart + b.frames - 1, true], [b.outStart + b.frames, false]]) {
        await page.eval(`${P}.seekTo(${f})`);
        await sleep(150);
        const card = await page.eval(`!!document.querySelector('.__remotion-player [data-moment-id="${b.id}"]')`);
        if (card !== expected) errors.push(`${b.id}: card ${card ? 'shown' : 'missing'} at frame ${f}`);
      }
      // Playhead at the hold start sits on the block's left edge.
      await page.eval(`${P}.seekTo(${b.outStart})`);
      await sleep(150);
      const head = JSON.parse(await page.eval(`JSON.stringify(document.querySelector('[data-testid=playhead]').getBoundingClientRect())`));
      // The 1 px playhead snaps to whole pixels, so allow a pixel when a frame is narrower.
      if (Math.abs(head.left - rect.left) > Math.max(framePx, 1)) errors.push(`${b.id}: playhead ${head.left.toFixed(1)} vs block ${rect.left.toFixed(1)}`);
    }
    result('timeline blocks line up with holds to within one frame', errors.length === 0, errors.join('; ') || `${blocks.length} holds`);
  }

  // 2. Review mode stops at every hold, once the card is in.
  {
    await page.eval(`${P}.seekTo(0)`);
    await sleep(300);
    const stopped = [];
    for (let i = 0; i < stops.length + 1; i++) {
      await page.key(' ');
      await sleep(200);
      await page.waitFor(`!${P}.isPlaying()`, 120000);
      stopped.push(await page.eval(`${P}.getCurrentFrame()`));
    }
    const expected = [...stops, Number(process.argv[5]) - 1];
    result('Review pauses at every hold', JSON.stringify(stopped) === JSON.stringify(expected), `stopped at ${stopped.join(', ')}; expected ${expected.join(', ')}`);
  }

  // 3. Preview plays straight through; sample the canvas for black flashes and frozen holds.
  {
    await page.eval(`document.querySelector('[role=radio][aria-checked=false]').click()`);
    await page.eval(`${P}.seekTo(0)`);
    await sleep(400);
    await page.eval(SAMPLER);
    await page.key(' ');
    await sleep(300);
    await page.waitFor(`!${P}.isPlaying()`, 300000);
    await page.eval(`window.__sampling = false`);
    const samples = JSON.parse(await page.eval(`JSON.stringify(window.__samples)`));
    const last = await page.eval(`${P}.getCurrentFrame()`);
    const pausedEarly = samples.filter((s) => !s.playing && s.frame < Number(process.argv[5]) - 1 && s.frame > 2).length;
    result('Preview plays straight through', last >= Number(process.argv[5]) - 1 && pausedEarly < 3, `ended at ${last}, ${samples.length} samples`);

    const black = samples.filter((s) => s.mean >= 0 && s.mean < 4);
    const sourceBlack = Number(process.argv[6] ?? 0);
    result('no black flashes during playback', black.length <= sourceBlack, `${black.length} dark samples${black.length ? ` at frames ${[...new Set(black.map((s) => s.frame))].slice(0, 12).join(',')}` : ''}`);

    const frozen = blocks.map((b) => {
      const inside = samples.filter((s) => s.frame >= b.outStart + 1 && s.frame < b.outStart + b.frames - 1);
      return { id: b.id, n: inside.length, distinct: new Set(inside.map((s) => s.hash)).size, card: inside.every((s) => s.card) };
    });
    result('video is frozen through each hold while the card shows', frozen.every((f) => f.distinct <= 1 && f.card && f.n > 0), frozen.map((f) => `${f.id}: ${f.n} samples, ${f.distinct} distinct image(s)`).join('; '));
    const fpsSeen = samples.length / ((samples.at(-1).frame - samples[0].frame) / fps);
    console.log(`      sampled ~${fpsSeen.toFixed(0)} times per second of output`);
  }
} finally {
  const errors = page.logs.filter((l) => /error|exception/i.test(l));
  if (errors.length) console.log(errors.slice(0, 10).join('\n'));
  page.close();
}
