// Creator-format checks against a running `pnpm dev`, in headless Chrome.
// usage: node scripts/browser/format-checks.mjs <scratchDir> <projectId>
// Use a project seeded from the fixture (`pnpm seed:sample`): Red plays White,
// Blue Black, m3 carries the motif "Sacrifice". The checks edit and save it.
import { launch, sleep } from './cdp.mjs';

const [S, projectId] = process.argv.slice(2);
const P = 'window.__alsPlayer';
const E = 'window.__alsEditor';
const result = (name, ok, detail = '') => console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);

const page = await launch({ profile: `${S}/chrome-format`, width: 1680, height: 1150 });
const open = async () => {
  await page.goto(`http://localhost:5173/#/projects/${projectId}`);
  await page.waitFor(`!!${P} && !!${E}`);
  await sleep(1000);
};
const pauseOn = async (id) => {
  await page.eval(`document.querySelector('[data-testid=moment-item][data-moment-id=${id}]').click()`);
  await page.waitFor(`!!document.querySelector('[data-testid=edit-layer] [data-field=moveLabel]')`);
  await sleep(300);
};
const cardText = () => page.eval(`document.querySelector('[data-testid=edit-layer] [data-moment-id]').textContent`);
const waitSaved = () => page.waitFor(`document.querySelector('[data-testid=save-status]').dataset.status === 'saved'`, 10000);
const tab = (name) => page.eval(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '${name}').click()`);
const pick = (testid, value) =>
  page.eval(`(() => {
    const sel = document.querySelector('[data-testid=${testid}]');
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, '${value}');
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
const pickTheme = (id) => pick('theme-picker', id);

try {
  await open();

  // 1. The look switches, follows the timing and survives a reload; undo switches back.
  {
    const before = await page.eval(`${E}.getState().doc.moments[0].holdSec`);
    await pickTheme('creator');
    await waitSaved();
    const after = await page.eval(`${E}.getState().doc.moments[0].holdSec`);
    await open();
    const reloaded = await page.eval(`${E}.getState().theme.id`);
    result('the creator look applies, lengthens holds for the badge, and survives a reload', reloaded === 'creator' && after > before, `hold ${before} s → ${after} s, after reload "${reloaded}"`);
  }

  // 2. The headline card: "<Move> is <phrase>", the move number line, the motif chip.
  {
    await pauseOn('m3');
    const text = await cardText();
    const ok = text.includes('Lights As Bait is brilliant') && text.includes('2 Red · Lights As Bait!!') && text.includes('Sacrifice');
    result('the card reads like the creator’s: headline, move number, notation, motif', ok, JSON.stringify(text.slice(0, 90)));
  }

  // 3. Sides set the numbering; switching Red to Black renumbers every card.
  {
    await pauseOn('m1');
    const white = await cardText();
    await tab('Cast');
    await page.eval(`document.querySelector('[data-testid=characters-panel] li [data-testid=side-black]').click()`);
    await sleep(200);
    const black = await cardText();
    result('White moves read "1", and switching to Black renumbers to "1..."', white.includes('1 Red ·') && black.includes('1... Red ·'), `${JSON.stringify(white.match(/\d+\.*\s\w+ ·/)?.[0])} → ${JSON.stringify(black.match(/\d+\.*\s\w+ ·/)?.[0])}`);
    await page.eval(`document.querySelector('[data-testid=characters-panel] li [data-testid=side-white]').click()`);
    await tab('Move');
  }

  // 4. A motif typed in the inspector shows in the chip on the next frame.
  {
    await pauseOn('m1');
    await page.eval(`(() => { const i = [...document.querySelectorAll('[data-testid=inspector] input')].find((x) => x.placeholder.startsWith('Sacrifice')); i.focus(); })()`);
    await page.send('Input.insertText', { text: 'Gambit' });
    await sleep(150);
    const chip = await page.eval(`document.querySelector('[data-testid=edit-layer] [data-part=motif]')?.textContent ?? ''`);
    await waitSaved();
    const saved = await page.eval(`fetch('/api/projects/${projectId}').then((r) => r.json()).then((p) => p.moments.find((m) => m.id === 'm1').motif)`);
    result('a motif typed in the inspector shows in the chip and saves', chip === 'Gambit' && saved === 'Gambit', `chip "${chip}", saved "${saved}"`);
    await page.eval(`document.activeElement.blur()`);
  }

  // 5. A theme switch undoes like any edit.
  {
    await pickTheme('default');
    const switched = await page.eval(`${E}.getState().theme.id`);
    await page.eval(`${E}.getState().undo()`);
    const undone = await page.eval(`${E}.getState().theme.id`);
    result('undo reverts a theme switch', switched === 'default' && undone === 'creator', `${switched} → undo → ${undone}`);
  }

  // 6. The format: a landscape clip starts long-form; short-form shortens every
  // unlocked hold by the reread (4 s → 1.4 s), saves, survives a reload and undoes.
  {
    const hold = () => page.eval(`${E}.getState().doc.moments.map((m) => m.holdSec).join(' ')`);
    const first = await page.eval(`${E}.getState().doc.format`);
    const before = await hold();
    await pick('format-picker', 'short');
    await waitSaved();
    const after = await hold();
    await open();
    const reloaded = await page.eval(`${E}.getState().doc.format`);
    const shorter = before.split(' ').every((h, i) => Math.abs(Number(h) - 2.6 - Number(after.split(' ')[i])) < 0.051);
    result('short-form shortens holds by the reread, saves and survives a reload', first === 'long' && shorter && reloaded === 'short', `${first}: ${before} → short: ${after}; after reload "${reloaded}"`);
    await pick('format-picker', 'long');
    await page.eval(`${E}.getState().undo()`);
    result('undo reverts a format switch', (await page.eval(`${E}.getState().doc.format`)) === 'short' && (await hold()) === after);
  }
} finally {
  page.close();
}
