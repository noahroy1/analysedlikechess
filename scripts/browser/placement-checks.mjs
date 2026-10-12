// Card placement checks against a running `pnpm dev` started with
// ANALYSIS_REPLAY_DIR=$PWD/fixtures/dialogue/recorded (the recorded Gemini answer
// stands in for every frame, so nothing is spent), in headless Chrome.
// usage: node scripts/browser/placement-checks.mjs <scratchDir> <projectId> [screenshotPrefix]
// Re-evaluate places a card clear of eyes and mouths; a retime places an automatic
// card again and one undo takes back both; a card set by hand stays through a
// retime; a new look moves only automatic cards; and the card-size estimate the
// placement relies on is checked against the card the browser draws.
import { estimateCardSize } from '../../packages/composition/src/placement.ts';
import { getTheme } from '../../packages/theme/src/themes.ts';
import { launch, sleep } from './cdp.mjs';

const [S, projectId, shots] = process.argv.slice(2);
const P = 'window.__alsPlayer';
const E = 'window.__alsEditor';
const result = (name, ok, detail = '') => console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);

const page = await launch({ profile: `${S}/chrome-placement`, width: 1680, height: 1150 });
try {
  await page.goto(`http://localhost:5173/#/projects/${projectId}`);
  await page.waitFor(`!!${P} && !!${E}`);
  await sleep(1200);
  await page.eval(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Preview')?.click()`);
  const state = (expr) => page.eval(`(() => { const s = ${E}.getState(); return JSON.stringify(${expr}); })()`).then(JSON.parse);
  const id = await state(`s.doc.moments[0].id`);
  const card = () => state(`s.doc.moments.find((m) => m.id === '${id}')`);
  const status = () => page.eval(`document.querySelector('[data-testid=placement-status] span')?.textContent ?? null`);
  const waitFor = async (expr, ms = 8000) => page.waitFor(`(() => { const s = ${E}.getState(); const m = s.doc.moments.find((x) => x.id === '${id}'); return ${expr}; })()`, ms);

  // Select the move with the playhead outside any hold, so the inspector shows it.
  await page.eval(`${P}.pause(); ${P}.seekTo(0); ${E}.getState().select('${id}')`);
  await page.waitFor(`!!document.querySelector('[data-testid=placement-status]')`);
  const start = await card();
  result('a card from before placement existed stays in the look’s corner', start.card.placement === undefined && /corner/.test(await status()), `${JSON.stringify(start.card)}; "${await status()}"`);

  // 1. Re-evaluate.
  await page.eval(`document.querySelector('[data-testid=reevaluate-placement]').click()`);
  await waitFor(`m.card.placement === 'auto' && m.regions && Math.abs(m.regions.sourceTime - m.sourceTime) < 1e-4`);
  const placed = await card();
  const toast = await page.eval(`document.querySelector('[data-testid=toast]')?.textContent ?? ''`);
  result('Re-evaluate places the card clear of faces', placed.card.anchor === 'custom' && /placed clear of 2 faces/.test(toast) && /Placed clear of faces/.test(await status()), `${JSON.stringify(placed.card)}; "${toast}"`);

  // The drawn card and badge, against the eyes and mouths, in the Player.
  const holds = JSON.parse(await page.eval(`JSON.stringify([...document.querySelectorAll('[data-testid=hold-block]')].map((b) => ({ id: b.dataset.momentId, start: Number(b.dataset.outStart), frames: Number(b.dataset.frames) })))`));
  const hold = holds.find((h) => h.id === id);
  await page.eval(`document.head.insertAdjacentHTML('beforeend', '<style>[data-testid=edit-layer]{display:none!important}</style>')`);
  const reread = hold.start + hold.frames - 20;
  await page.eval(`${P}.pause(); ${P}.seekTo(${reread})`);
  await sleep(600);
  const geometry = JSON.parse(
    await page.eval(`(() => {
      const stage = document.querySelector('[data-testid=stage]').getBoundingClientRect();
      const card = document.querySelector('.__remotion-player [data-moment-id="${id}"]');
      const rects = [card.firstElementChild?.dataset.part === 'badge' ? card.children[1] : card, card.querySelector('[data-part=badge]')]
        .filter(Boolean).map((el) => el.getBoundingClientRect()).map((r) => ({ left: r.left - stage.left, top: r.top - stage.top, right: r.right - stage.left, bottom: r.bottom - stage.top }));
      return JSON.stringify({ stage: { width: stage.width, height: stage.height }, rects });
    })()`),
  );
  const bands = placed.regions.faces.filter((f) => f.eyesMouth).map(({ eyesMouth: b }) => ({
    left: b.x * geometry.stage.width,
    top: b.y * geometry.stage.height,
    right: (b.x + b.w) * geometry.stage.width,
    bottom: (b.y + b.h) * geometry.stage.height,
  }));
  const hits = geometry.rects.flatMap((r) => bands.filter((b) => r.left < b.right && r.right > b.left && r.top < b.bottom && r.bottom > b.top));
  result('the drawn card and badge leave every eyes-and-mouth box clear', bands.length > 0 && hits.length === 0, `${bands.length} boxes, ${geometry.rects.length} parts drawn, ${hits.length} overlapping`);
  if (shots) {
    await page.eval(`document.head.insertAdjacentHTML('beforeend', '<style id=boxes></style>')`);
    const stageRect = JSON.parse(await page.eval(`JSON.stringify(document.querySelector('[data-testid=stage]').getBoundingClientRect())`));
    await page.screenshot(`${shots}-placed.png`, { x: stageRect.x, y: stageRect.y, width: stageRect.width, height: stageRect.height });
  }

  // 2. A retime places an automatic card again, folded into the retime's undo step.
  await page.eval(`${P}.pause(); ${P}.seekTo(0)`);
  const before = await card();
  const moved = before.sourceTime + 0.4;
  await page.eval(`${E}.getState().edit((d) => ({ ...d, moments: d.moments.map((m) => (m.id === '${id}' ? { ...m, sourceTime: ${moved} } : m)) }))`);
  await waitFor(`Math.abs(m.regions.sourceTime - ${moved}) < 1e-4`);
  const after = await card();
  await page.eval(`${E}.getState().undo()`);
  const undone = await card();
  result(
    'a retime looks at the new frame and places the card again; one undo takes back both',
    after.card.placement === 'auto' && JSON.stringify(undone) === JSON.stringify(before),
    `regions at ${after.regions.sourceTime.toFixed(2)} s; undo back to ${undone.sourceTime.toFixed(2)} s with the earlier card`,
  );

  // 3. Set by hand: the size slider. A retime then keeps it where it is.
  await page.eval(`(() => {
    const slider = document.querySelector('input[type=range]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(slider, '1.2');
    slider.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await waitFor(`m.card.placement === 'user'`);
  const byHand = await card();
  await page.eval(`${E}.getState().edit((d) => ({ ...d, moments: d.moments.map((m) => (m.id === '${id}' ? { ...m, sourceTime: ${moved} } : m)) }))`);
  await sleep(2000);
  const kept = await card();
  result(
    'a card sized by hand keeps its position and size through a retime',
    JSON.stringify(kept.card) === JSON.stringify(byHand.card) && kept.regions.sourceTime === byHand.regions.sourceTime && /Placed by you/.test(await status()),
    `${JSON.stringify(kept.card)}; "${await status()}"`,
  );

  // 4. Re-evaluate takes it back from the hand-set position.
  await page.eval(`document.querySelector('[data-testid=reevaluate-placement]').click()`);
  await waitFor(`m.card.placement === 'auto' && Math.abs(m.regions.sourceTime - m.sourceTime) < 1e-4`);
  const back = await card();
  result('Re-evaluate replaces a position set by hand', back.card.scale <= 1 && back.card.anchor === 'custom', JSON.stringify(back.card));

  // 5. A new look moves only automatic cards.
  const others = await state(`s.doc.moments.filter((m) => m.id !== '${id}').map((m) => m.card)`);
  await page.eval(`(() => {
    const select = document.querySelector('[data-testid=theme-picker]');
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, 'creator');
    select.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await page.waitFor(`${E}.getState().doc.themeId === 'creator'`);
  const themed = await card();
  const othersAfter = await state(`s.doc.moments.filter((m) => m.id !== '${id}').map((m) => m.card)`);
  result(
    'a new look moves the automatic card for its badge, and leaves the others',
    JSON.stringify(themed.card) !== JSON.stringify(back.card) && JSON.stringify(othersAfter) === JSON.stringify(others),
    `${JSON.stringify(back.card)} → ${JSON.stringify(themed.card)}`,
  );

  // 6. The size estimate against the drawn card, for every move, in both looks.
  const rows = [];
  for (const look of ['creator', 'default']) {
    await page.eval(`(() => {
      const select = document.querySelector('[data-testid=theme-picker]');
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, '${look}');
      select.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await sleep(400);
    const theme = getTheme(look);
    const doc = await state(`({ moments: s.doc.moments, characters: s.doc.characters, width: s.project.source.width, height: s.project.source.height })`);
    const holdsNow = JSON.parse(await page.eval(`JSON.stringify([...document.querySelectorAll('[data-testid=hold-block]')].map((b) => ({ id: b.dataset.momentId, start: Number(b.dataset.outStart), frames: Number(b.dataset.frames) })))`));
    for (const m of doc.moments) {
      const h = holdsNow.find((x) => x.id === m.id);
      await page.eval(`${P}.pause(); ${P}.seekTo(${h.start + h.frames - 20})`);
      await sleep(400);
      const drawn = JSON.parse(
        await page.eval(`(() => {
          const stage = document.querySelector('[data-testid=stage]').getBoundingClientRect();
          const root = document.querySelector('.__remotion-player [data-moment-id="${m.id}"]');
          const box = [...root.children].find((c) => c.dataset.part !== 'badge');
          return JSON.stringify({ height: box.getBoundingClientRect().height, scale: stage.width / ${doc.width} });
        })()`),
      );
      const who = [doc.characters.find((c) => c.id === m.actorId)?.name].filter(Boolean).join(' ');
      const unit = (doc.height / 1080) * theme.layout.scale * m.card.scale;
      const estimate = estimateCardSize(m, theme, who).height * unit;
      const actual = drawn.height / drawn.scale;
      rows.push({ look, id: m.id, estimate, actual, ratio: estimate / actual });
    }
  }
  const worstUnder = Math.min(...rows.map((r) => r.ratio));
  const worstOver = Math.max(...rows.map((r) => r.ratio));
  result(
    'the card-size estimate matches the drawn card (within 15%)',
    worstUnder >= 0.85 && worstOver <= 1.15,
    rows.map((r) => `${r.look} ${r.id} ${Math.round(r.estimate)}/${Math.round(r.actual)}`).join(', '),
  );

  const errors = page.logs.filter((l) => l.startsWith('[error]') || l.startsWith('[exception]'));
  result('no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} finally {
  page.close();
}
