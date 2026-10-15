// Game review checks against a running `pnpm dev`, in headless Chrome.
// usage: node scripts/browser/review-checks.mjs <scratchDir> <projectId>
// Use a project seeded from the fixture (`pnpm seed:sample`): Red plays White,
// Blue Black; m1 is Red's mistake, m2 Blue's book move, m3 Red's brilliant.
// The checks switch it to the creator look, value two moves, and edit the review.
import { launch, sleep } from './cdp.mjs';

const [S, projectId] = process.argv.slice(2);
const P = 'window.__alsPlayer';
const E = 'window.__alsEditor';
const result = (name, ok, detail = '') => console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);

const page = await launch({ profile: `${S}/chrome-review`, width: 1680, height: 1150 });
const open = async () => {
  await page.goto(`http://localhost:5173/#/projects/${projectId}`);
  await page.waitFor(`!!${P} && !!${E}`);
  await sleep(1000);
};
const waitSaved = () => page.waitFor(`document.querySelector('[data-testid=save-status]').dataset.status === 'saved'`, 10000);
const setLook = async (id) => {
  await page.eval(`(() => {
    const sel = document.querySelector('[data-testid=theme-picker]');
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, '${id}');
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await sleep(500);
};
const block = async () => JSON.parse(await page.eval(`JSON.stringify((() => { const b = document.querySelector('[data-testid=game-review-block]'); return b ? { start: +b.dataset.outStart, frames: +b.dataset.frames } : null; })())`));
const seek = async (frame) => {
  await page.eval(`${P}.pause(); ${P}.seekTo(${frame})`);
  await sleep(400);
};
/** Replaces a field's text with real key input, then blurs it to commit. */
const type = async (selector, text) => {
  await page.eval(`(() => { const el = document.querySelector('${selector}'); el.focus(); el.select(); })()`);
  await page.send('Input.insertText', { text });
  await sleep(50);
  await page.eval(`document.querySelector('${selector}').blur()`);
  await sleep(150);
};
const review = async () =>
  JSON.parse(
    await page.eval(`JSON.stringify((() => {
      const r = document.querySelector('[data-testid=game-review]');
      if (!r) return null;
      const q = (s) => r.querySelector(s)?.textContent;
      const rows = Object.fromEntries([...r.querySelectorAll('[data-testid^=game-review-row-]')].map((row) => {
        const cells = [...row.children].map((c) => c.textContent);
        return [row.dataset.testid.replace('game-review-row-', ''), [cells[1], cells[3]]];
      }));
      return {
        // Premounted a second early, hidden, so its portraits are loaded when it cuts in.
        visible: r.checkVisibility({ opacityProperty: true, visibilityProperty: true }),
        winner: r.dataset.winner,
        summary: q('[data-testid=game-review-summary]'),
        names: [q('[data-testid=game-review-white] div'), q('[data-testid=game-review-black] div')],
        accuracy: [q('[data-testid=game-review-accuracy-white]'), q('[data-testid=game-review-accuracy-black]')],
        rows,
        dots: [...r.querySelectorAll('[data-testid=game-review-graph] circle')].map((c) => c.dataset.classification),
        bar: !!document.querySelector('[data-testid=eval-bar]'),
      };
    })())`),
  );

try {
  await open();
  const fps = await page.eval(`${E}.getState().project.source.fps`);

  // 1. Only the creator look has a review: a block after the clip's last frame, counted in the length.
  {
    const none = await block();
    await setLook('creator');
    const b = await block();
    const out = await page.eval(`document.querySelector('[data-testid=clock]').textContent`);
    const timeline = JSON.parse(await page.eval(`JSON.stringify((() => { const s = ${E}.getState(); return { holds: s.doc.moments.reduce((a, m) => a + Math.max(1, Math.round(m.holdSec * ${fps})), 0), source: Math.round(s.project.source.durationSec * ${fps}) }; })())`));
    const ok = none === null && b && b.frames === Math.round(5 * fps) && b.start === timeline.source + timeline.holds;
    result('the creator look adds a 5 s review after the last frame; the default look has none', !!ok, `default ${JSON.stringify(none)}, creator ${JSON.stringify(b)}, play ${timeline.source + timeline.holds} frames, clock ${out}`);
  }

  // 2. On the review: the cast, their tallies, a dot per move, the default accuracy; the bar steps aside.
  {
    const b = await block();
    await seek(b.start - 2);
    const before = await review();
    await seek(b.start + 5);
    const r = await review();
    const ok =
      !before.visible &&
      before.bar &&
      r.visible &&
      !r.bar &&
      r.names.join() === 'Red,Blue' &&
      r.rows.mistake.join() === '1,0' &&
      r.rows.book.join() === '0,1' &&
      r.rows.brilliant.join() === '1,0' &&
      Object.values(r.rows).flat().reduce((a, n) => a + Number(n), 0) === 3 &&
      r.dots.join() === 'mistake,book,brilliant' &&
      r.accuracy.join() === '70.0,70.0';
    result('the review shows the cast, their moves by rating, a dot per move and 70.0 each, with no bar over it', !!ok, `before: visible ${before.visible}, bar ${before.bar}; on it: ${JSON.stringify(r)}`);
  }

  // 3. The result follows the bar: Black's blunder hands White a mate.
  {
    await page.eval(`${E}.getState().edit((d) => ({ ...d, moments: d.moments.map((m) => m.id === 'm2' ? { ...m, classification: 'blunder', eval: { pawns: 4 } } : m.id === 'm3' ? { ...m, eval: { mate: 2 } } : m) }))`);
    await sleep(400);
    const r = await review();
    const ok = r.winner === 'white' && r.summary === 'Red won with a mating attack, turning an even game into victory!' && r.rows.blunder.join() === '0,1';
    result('the winner and the summary follow the bar', ok, `${r.winner}: "${r.summary}"`);
  }

  // 4. Accuracy and summary are edited in the inspector, saved, and undoable.
  {
    await page.eval(`${E}.getState().select(null)`);
    await sleep(200);
    const placeholder = await page.eval(`document.querySelector('[data-testid=review-summary]').placeholder`);
    await type('[data-testid=review-accuracy-white]', '71.6');
    await type('[data-testid=review-accuracy-black]', '61.6');
    await type('[data-testid=review-summary]', 'You won with a nice midgame mating tactic!');
    const edited = await review();
    await page.eval(`${E}.getState().undo()`);
    await sleep(300);
    const undone = await review();
    await page.eval(`${E}.getState().redo()`);
    await waitSaved();
    await open();
    const b = await block();
    await seek(b.start + 5);
    const reloaded = await review();
    const ok =
      placeholder === 'Red won with a mating attack, turning an even game into victory!' &&
      edited.accuracy.join() === '71.6,61.6' &&
      edited.summary === 'You won with a nice midgame mating tactic!' &&
      reloaded.accuracy.join() === '71.6,61.6' &&
      reloaded.summary === edited.summary &&
      undone.summary === placeholder;
    result('accuracy and summary are typed in the inspector, undo, and survive a reload', ok, `edited ${edited.accuracy} "${edited.summary}"; reloaded ${reloaded.accuracy}; undone "${undone.summary}"`);
  }

  // 5. Clicking the timeline's Review block shows it; M there adds no move.
  {
    await seek(0);
    const rect = JSON.parse(await page.eval(`JSON.stringify(document.querySelector('[data-testid=game-review-block]').getBoundingClientRect())`));
    await page.click(rect.x + rect.width / 2, rect.y + rect.height / 2);
    await sleep(400);
    const frame = await page.eval(`${P}.getCurrentFrame()`);
    const b = await block();
    const moves = await page.eval(`${E}.getState().doc.moments.length`);
    await page.key('m');
    await sleep(300);
    const after = await page.eval(`${E}.getState().doc.moments.length`);
    result('the Review block seeks to the review, and M there adds no move', frame === b.start && after === moves, `frame ${frame} of ${b.start}, moves ${moves} → ${after}`);
  }

  await page.screenshot(`${S}/review-check.png`);
} finally {
  page.close();
}
