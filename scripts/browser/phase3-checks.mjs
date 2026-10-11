// Phase 3 checks against a running `pnpm dev`, in headless Chrome.
// usage: node scripts/browser/phase3-checks.mjs <scratchDir> <projectId>
// Use a project seeded from the fixture (`pnpm seed:sample`): it needs the fixture's
// moments (m1-m3) and transcript. The checks edit and save that project.
import { launch, sleep } from './cdp.mjs';

const [S, projectId] = process.argv.slice(2);
const P = 'window.__alsPlayer';
const E = 'window.__alsEditor';
const result = (name, ok, detail = '') => console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
const moment = (id) => `${E}.getState().doc.moments.find((m) => m.id === '${id}')`;

const page = await launch({ profile: `${S}/chrome`, width: 1680, height: 1150 });
const open = async () => {
  await page.goto(`http://localhost:5173/#/projects/${projectId}`);
  await page.waitFor(`!!${P} && !!${E}`);
  await sleep(1200);
};
const pauseOn = async (id) => {
  await page.eval(`document.querySelector('[data-testid=moment-item][data-moment-id=${id}]').click()`);
  await page.waitFor(`!!document.querySelector('[data-testid=edit-layer] [data-field=moveLabel]')`);
  await sleep(300);
};
const waitSaved = () => page.waitFor(`document.querySelector('[data-testid=save-status]').dataset.status === 'saved'`, 10000);

try {
  await open();

  // 1. Text typed during a hold shows in the card on the next frame.
  {
    await pauseOn('m1');
    await page.eval(`(() => {
      window.__typed = [];
      document.addEventListener('input', (e) => {
        const typed = e.target.textContent;
        const at = performance.now();
        requestAnimationFrame(() => requestAnimationFrame(() => {
          const card = document.querySelector('.__remotion-player [data-moment-id=m1]');
          window.__typed.push({ typed, rendered: card?.textContent ?? '', ms: performance.now() - at });
        }));
      }, true);
      const field = document.querySelector('[data-testid=edit-layer] [data-field=moveLabel]');
      field.focus();
      const r = document.createRange(); r.selectNodeContents(field); r.collapse(false);
      getSelection().removeAllRanges(); getSelection().addRange(r);
    })()`);
    for (const ch of ' at night') {
      await page.send('Input.insertText', { text: ch });
      await sleep(60);
    }
    await sleep(300);
    const samples = JSON.parse(await page.eval(`JSON.stringify(window.__typed)`));
    const ok = samples.length === 9 && samples.every((s) => s.rendered.includes(s.typed));
    const label = await page.eval(`${moment('m1')}.moveLabel`);
    result('text typed during a hold shows in the card on the next frame', ok && label === 'Splits Up at night',
      `${samples.length} keystrokes, each in the rendered card within ${Math.max(...samples.map((s) => s.ms)).toFixed(0)} ms; label "${label}"`);
    await page.eval(`document.activeElement.blur()`);
  }

  // 2. Dragging a block retimes it; snapping on, Shift turns it off.
  {
    const dragBlock = async (id, deltaSec, shift) => {
      const geo = JSON.parse(await page.eval(`(() => {
        const el = document.querySelector('[data-testid=hold-block][data-moment-id=${id}]');
        const b = el.getBoundingClientRect();
        // The fixture runs at 30 fps; a block is exactly as wide as its hold.
        return JSON.stringify({ x: b.left + b.width / 2, y: b.top + b.height / 2, pxPerSec: (b.width / +el.dataset.frames) * 30 });
      })()`));
      const modifiers = shift ? 8 : 0;
      const target = geo.x + deltaSec * geo.pxPerSec;
      await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: geo.x, y: geo.y, button: 'left', clickCount: 1, modifiers });
      for (let i = 1; i <= 8; i++) {
        await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: geo.x + ((target - geo.x) * i) / 8, y: geo.y, button: 'left', buttons: 1, modifiers });
        await sleep(30);
      }
      const tip = await page.eval(`document.querySelector('[data-testid=drag-tip]')?.textContent ?? ''`);
      await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: target, y: geo.y, button: 'left', clickCount: 1, modifiers });
      await sleep(200);
      return { time: await page.eval(`${moment(id)}.sourceTime`), tip };
    };
    // m2 freezes at 5.2 s (after "door."). Words end at 4.30, 4.55, 4.65, 4.85, 5.05 s,
    // so speech targets sit 0.15 s later; dragging ~0.48 s left lands near 4.70 s.
    const snapped = await dragBlock('m2', -0.48, false);
    const speechTargets = [4.45, 4.7, 4.8, 5.0, 5.2].map((t) => Math.round(t * 30) / 30);
    const snappedOk = speechTargets.some((t) => Math.abs(t - snapped.time) < 1e-6);
    await page.eval(`${E}.getState().undo()`);
    const free = await dragBlock('m2', -0.48, true);
    const onFrame = Math.abs(free.time * 30 - Math.round(free.time * 30)) < 1e-6;
    const freeOk = onFrame && !speechTargets.some((t) => Math.abs(t - free.time) < 1e-6);
    result('dragging a block retimes it, snapping to speech', snappedOk, `landed at ${snapped.time.toFixed(3)} s, tip "${snapped.tip}"`);
    result('Shift turns snapping off', freeOk, `landed at ${free.time.toFixed(3)} s, tip "${free.tip}"`);
    await page.eval(`${E}.getState().undo()`);
    const restored = await page.eval(`${moment('m2')}.sourceTime`);
    result('undo restores the previous state', restored === 5.2, `m2 back at ${restored} s`);
  }

  // 3. A reload keeps every edit, including plain typing with nothing else after it.
  {
    await waitSaved();
    await pauseOn('m3');
    // The label input, found by its value: the Regenerate box sits above it.
    await page.eval(`(() => { const i = [...document.querySelectorAll('[data-testid=inspector] input')].find((x) => x.value === ${moment('m3')}.moveLabel); i.focus(); i.setSelectionRange(i.value.length, i.value.length); })()`);
    await page.send('Input.insertText', { text: ' (typed)' });
    await sleep(100);
    await waitSaved();
    await open();
    const label = await page.eval(`${moment('m1')}.moveLabel`);
    const m2 = await page.eval(`${moment('m2')}.sourceTime`);
    const m3 = await page.eval(`${moment('m3')}.moveLabel`);
    result('a reload keeps every edit', label === 'Splits Up at night' && m2 === 5.2 && m3.endsWith('(typed)'), `m1 "${label}", m2 at ${m2} s, m3 "${m3}"`);
  }

  // 4. A stale save gets a 409 and the editor reloads instead of overwriting.
  {
    const base = await page.eval(`${E}.getState().baseVersion`);
    // Someone else saves first.
    const other = await page.eval(`(async () => {
      const p = await (await fetch('/api/projects/${projectId}')).json();
      p.moments[2].moveLabel = 'Changed in another tab';
      const res = await fetch('/api/projects/${projectId}', { method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ version: p.version, moments: p.moments, characters: p.context.characters }) });
      return res.status;
    })()`);
    // Now this editor saves on top of its stale version.
    await page.eval(`${E}.getState().edit((d) => ({ ...d, moments: d.moments.map((m) => m.id === 'm1' ? { ...m, moveLabel: 'Stale local edit' } : m) }))`);
    await page.waitFor(`document.querySelector('[data-testid=toast]')?.textContent.includes('changed somewhere else')`, 10000);
    const m1 = await page.eval(`${moment('m1')}.moveLabel`);
    const m3 = await page.eval(`${moment('m3')}.moveLabel`);
    const server = await page.eval(`(async () => (await (await fetch('/api/projects/${projectId}')).json()).moments[0].moveLabel)()`);
    result('a stale save gets a 409 and reloads', other === 200 && m3 === 'Changed in another tab' && m1 !== 'Stale local edit' && server !== 'Stale local edit',
      `base v${base}; other tab saved (${other}); editor now shows "${m3}"; server kept m1 "${server}"`);
  }
} finally {
  const errs = page.logs.filter((l) => /error|exception/i.test(l) && !/409/.test(l));
  if (errs.length) console.log(errs.slice(0, 10).join('\n'));
  page.close();
}
