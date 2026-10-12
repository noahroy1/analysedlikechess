// Evaluation-bar checks against a running `pnpm dev`, in headless Chrome.
// usage: node scripts/browser/evalbar-checks.mjs <scratchDir> <projectId>
// Use a project seeded from the fixture (`pnpm seed:sample`): Red plays White,
// Blue Black; m1 is Red's mistake, m2 Blue's book move, m3 Red's brilliant.
// The checks edit and save it.
import { launch, sleep } from './cdp.mjs';

const [S, projectId] = process.argv.slice(2);
const P = 'window.__alsPlayer';
const E = 'window.__alsEditor';
const result = (name, ok, detail = '') => console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);

const page = await launch({ profile: `${S}/chrome-evalbar`, width: 1680, height: 1150 });
const open = async () => {
  await page.goto(`http://localhost:5173/#/projects/${projectId}`);
  await page.waitFor(`!!${P} && !!${E}`);
  await sleep(1000);
};
const waitSaved = () => page.waitFor(`document.querySelector('[data-testid=save-status]').dataset.status === 'saved'`, 10000);
const bar = async () => JSON.parse(await page.eval(`JSON.stringify({ ...document.querySelector('[data-testid=eval-bar]')?.dataset })`));
const seek = async (frame) => {
  await page.eval(`${P}.pause(); ${P}.seekTo(${frame})`);
  await sleep(250);
};
/** Replaces an input's text with real key input, then blurs it to commit. */
const type = async (selector, text) => {
  await page.eval(`(() => { const el = document.querySelector('${selector}'); el.focus(); el.select(); })()`);
  await page.send('Input.insertText', { text });
  await sleep(50);
  await page.eval(`document.querySelector('${selector}').blur()`);
  await sleep(50);
};
/** Selects a move or beat with the Player on frame 0, outside any hold (a paused hold keeps its own move selected). */
const select = async (id) => {
  await page.eval(`${P}.pause(); ${P}.seekTo(0)`);
  await sleep(150);
  await page.eval(`${E}.getState().select(${JSON.stringify(id)})`);
  await sleep(200);
};
const holds = async () =>
  JSON.parse(await page.eval(`JSON.stringify([...document.querySelectorAll('[data-testid=hold-block]')].map((b) => ({ id: b.dataset.momentId, start: Number(b.dataset.outStart), frames: Number(b.dataset.frames) })))`));
const inspectorText = () => page.eval(`document.querySelector('[data-testid=inspector], [data-testid=beat-inspector]')?.textContent ?? ''`);

try {
  await open();
  const fps = await page.eval(`${E}.getState().project.source.fps`);

  // 1. The creator look draws the bar; the default look does not.
  {
    const before = await page.eval(`!!document.querySelector('[data-testid=eval-bar]')`);
    await page.eval(`(() => {
      const sel = document.querySelector('[data-testid=theme-picker]');
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, 'creator');
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await sleep(500);
    const after = await bar();
    result('the creator look draws the bar between the two players; the default look has none', !before && after.label !== undefined, `default: ${before}, creator: ${after.label}`);
  }

  // 2. The start of the scene, set with nothing selected.
  {
    await select(null);
    await type('[data-testid=start-eval]', '-1.5');
    await seek(0);
    const b = await bar();
    result('the start value shows before any move, leaning to Black', b.label === '-1.5' && Number(b.fill) < 0.5, `label ${b.label}, fill ${b.fill}`);
  }

  // 3. A move's eval lands after its hold settles, stepping through readings first.
  {
    await select('m1');
    await type('[data-testid=moment-eval]', '-3');
    await select('m3');
    await type('[data-testid=moment-eval]', 'M4');
    await waitSaved();
    const hold = (await holds()).find((h) => h.id === 'm3');
    const labels = [];
    for (const sec of [0, 0.1, 0.25, 0.4, 0.65, 0.9, 1.2, 1.5, 1.9, 2.5, 4]) {
      await seek(hold.start + Math.round(sec * fps));
      labels.push((await bar()).label);
    }
    const distinct = [...new Set(labels)];
    const ok = labels[0] === '-3.0' && labels.at(-1) === 'M4' && distinct.length >= 4;
    result('a new eval settles like an engine: old value, a few readings, then the mate', ok, labels.join(' → '));
    const end = await bar();
    result('a mate fills the bar', Number(end.fill) > 0.999, `fill ${end.fill}`);
  }

  // 4. A rating that moves the bar the wrong way is flagged, not blocked.
  {
    await select('m1');
    await type('[data-testid=moment-eval]', '2');
    await sleep(200);
    const text = await inspectorText();
    const warned = text.includes('The bar rises for Red on a mistake');
    await type('[data-testid=moment-eval]', '-3');
    await sleep(200);
    const cleared = !(await inspectorText()).includes('The bar rises');
    result('a mistake that helps its maker is flagged, and the flag clears when fixed', warned && cleared, warned ? '' : text.slice(text.indexOf('Bar after'), text.indexOf('Bar after') + 220));
  }

  // 5. A beat at the playhead holds the bar's value, moves it during play, and deletes with undo.
  {
    const h = await holds();
    const m1 = h.find((x) => x.id === 'm1');
    // 1.6 s of source after m1's freeze: mid-play, before m2.
    const frame = m1.start + m1.frames + Math.round(1.6 * fps);
    await select(null);
    await seek(frame);
    await page.key('b');
    await sleep(300);
    const id = await page.eval(`${E}.getState().selectedId`);
    const beat = await page.eval(`JSON.stringify(${E}.getState().doc.evalBar.beats.find((b) => b.id === '${id}'))`).then(JSON.parse);
    const dot = await page.eval(`!!document.querySelector('[data-testid=beat-dot][data-beat-id="${id}"]')`);
    const shown = await page.eval(`!!document.querySelector('[data-testid=beat-inspector]')`);
    result('B adds a beat at the playhead holding the current value, shown on the bar lane', beat?.eval?.pawns === -3 && dot && shown, `${id} at ${beat?.sourceTime?.toFixed(2)} s, ${JSON.stringify(beat?.eval)}`);

    await type('[data-testid=beat-eval]', '-2.6');
    await seek(frame + Math.round(1.5 * fps));
    const after = await bar();
    await seek(frame - 2);
    const before = await bar();
    result('the bar moves at the beat while the video plays', before.label === '-3.0' && after.label === '-2.6', `${before.label} → ${after.label}`);

    await page.key('Delete');
    await sleep(200);
    const gone = await page.eval(`!document.querySelector('[data-testid=beat-dot][data-beat-id="${id}"]')`);
    await page.eval(`${E}.getState().undo()`);
    await sleep(200);
    const back = await page.eval(`!!document.querySelector('[data-testid=beat-dot][data-beat-id="${id}"]')`);
    result('Delete removes the selected beat and undo brings it back', gone && back);
  }

  // 6. Everything saves and survives a reload.
  {
    await waitSaved();
    await open();
    const doc = JSON.parse(await page.eval(`JSON.stringify(${E}.getState().doc)`));
    const ok = doc.evalBar?.start?.pawns === -1.5 && doc.evalBar.beats.length === 1 && doc.moments.find((m) => m.id === 'm3')?.eval?.mate === 4;
    result('the start, the beat and the move evals survive a reload', ok, JSON.stringify(doc.evalBar));
  }
} catch (error) {
  result('evaluation bar checks ran', false, error instanceof Error ? error.message : String(error));
} finally {
  page.close();
}
