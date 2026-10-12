// Subtitle checks against a running `pnpm dev`, in headless Chrome.
// usage: node scripts/browser/subtitle-checks.mjs <scratchDir> <projectId> [screenshotPrefix]
// Use a project seeded from the fixture (`pnpm seed:sample`): three spoken
// lines, each followed by a move that freezes just after it. The checks edit
// and save the project.
import { launch, sleep } from './cdp.mjs';

const [S, projectId, shots] = process.argv.slice(2);
const P = 'window.__alsPlayer';
const E = 'window.__alsEditor';
const result = (name, ok, detail = '') => console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);

const page = await launch({ profile: `${S}/chrome-subtitles`, width: 1680, height: 1150 });
const open = async () => {
  await page.goto(`http://localhost:5173/#/projects/${projectId}`);
  await page.waitFor(`!!${P} && !!${E}`);
  await sleep(1000);
};
const waitSaved = () => page.waitFor(`document.querySelector('[data-testid=save-status]').dataset.status === 'saved'`, 10000);
const holds = async () =>
  JSON.parse(await page.eval(`JSON.stringify([...document.querySelectorAll('[data-testid=hold-block]')].map((b) => ({ id: b.dataset.momentId, start: Number(b.dataset.outStart), frames: Number(b.dataset.frames) })))`));
/** The output frame showing a source time during play: the source frame plus every hold before it. */
const outFrame = async (sec) => {
  const fps = await page.eval(`${E}.getState().project.source.fps`);
  let frame = Math.round(sec * fps);
  let held = 0;
  for (const h of await holds()) if (h.start - held <= frame) held += h.frames;
  return frame + held;
};
const seek = async (frame) => {
  await page.eval(`${P}.pause(); ${P}.seekTo(${frame})`);
  await sleep(300);
};
const shown = () => page.eval(`document.querySelector('[data-testid=stage] [data-testid=subtitle]')?.textContent ?? null`);
/** The subtitle's font size and width at 1080p. Computed sizes are in composition pixels; the box is scaled by the Player too. */
const measure = () =>
  page.eval(`(() => {
    const el = document.querySelector('[data-testid=stage] [data-testid=subtitle]');
    const { width, height } = ${E}.getState().project.source;
    const to1080 = 1080 / height;
    const scale = document.querySelector('[data-testid=stage]').getBoundingClientRect().width / width * (height / 1080);
    const cs = getComputedStyle(el);
    return { size: parseFloat(cs.fontSize) * to1080, width: el.getBoundingClientRect().width / scale, weight: cs.fontWeight, family: cs.fontFamily, stroke: cs.webkitTextStrokeWidth, paintOrder: cs.paintOrder };
  })()`);
const setLook = (id) =>
  page.eval(`(() => {
    const sel = document.querySelector('[data-testid=theme-picker]');
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, '${id}');
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
const panelLines = () =>
  page.eval(`JSON.stringify([...document.querySelectorAll('[data-testid=subtitles-panel] input[aria-label="Subtitle text"]')].map((i) => i.value))`).then(JSON.parse);

try {
  await open();
  await setLook('creator');
  await sleep(500);

  // 1. Lines follow the speech in source time, with nothing between them.
  {
    await seek(await outFrame(1.4));
    const during = await shown();
    await seek(await outFrame(3.2));
    const gap = await shown();
    result('a line shows while it is spoken, and nothing between lines', during === "Okay, let's split up." && gap === null, `1.4 s "${during}", 3.2 s ${JSON.stringify(gap)}`);
  }

  // 2. The line spoken before a freeze stays up through the hold, over the dim.
  {
    const [m1] = await holds();
    await page.eval(`document.head.insertAdjacentHTML('beforeend', '<style>[data-testid=edit-layer]{display:none!important}</style>')`);
    await seek(m1.start + Math.round(m1.frames / 2));
    const text = await shown();
    const onTop = await page.eval(`(() => {
      const sub = document.querySelector('[data-testid=stage] [data-testid=subtitle]');
      // The hold's dim layer; the subtitle is drawn after it, so on top.
      const dim = [...document.querySelectorAll('[data-testid=stage] div')].find((d) => d.style.backgroundColor === 'rgba(0, 0, 0, 0.1)');
      return !!sub && !!dim && !!(dim.compareDocumentPosition(sub) & Node.DOCUMENT_POSITION_FOLLOWING);
    })()`);
    if (shots) {
      const r = JSON.parse(await page.eval(`JSON.stringify(document.querySelector('[data-testid=stage]').getBoundingClientRect())`));
      await page.screenshot(`${shots}-hold.png`, { x: r.x, y: r.y, width: r.width, height: r.height });
    }
    result('the line before a freeze stays up through the hold, drawn over the dim', text === "Okay, let's split up." && onTop, `mid-hold "${text}"`);
    await page.eval(`document.head.lastElementChild.remove()`);
  }

  // 3. The creator's measured look.
  {
    const m = await measure();
    const ok = Math.abs(m.size - 50) < 0.5 && m.weight === '700' && /Arial/.test(m.family) && m.paintOrder.startsWith('stroke');
    result('the creator look: Arial Bold 50 px, white, outline outside the letters', ok, `${m.size.toFixed(1)} px, weight ${m.weight}, stroke ${m.stroke}, paint-order ${m.paintOrder}`);
  }

  // 4. Fixing a line in the Subtitles tab changes the video and saves.
  {
    await page.eval(`[...document.querySelectorAll('[role=tab]')].find((t) => t.textContent === 'Subtitles').click()`);
    await sleep(300);
    const before = await panelLines();
    const status = await page.eval(`document.querySelector('[data-testid=subtitles-panel] p').textContent`);
    await page.eval(`(() => { const el = document.querySelector('[data-testid=subtitles-panel] input[aria-label="Subtitle text"]'); el.focus(); el.select(); })()`);
    await sleep(300);
    await page.send('Input.insertText', { text: 'Come out of the bathroom!' });
    await sleep(300);
    const live = await shown();
    const m = await measure();
    await page.eval(`document.activeElement.blur()`);
    await waitSaved();
    if (shots) {
      const r = JSON.parse(await page.eval(`JSON.stringify(document.querySelector('[data-testid=stage]').getBoundingClientRect())`));
      await page.screenshot(`${shots}-edited.png`, { x: r.x, y: r.y, width: r.width, height: r.height });
    }
    // The creator's own "Come out of the bathroom!" is 638 px of white at 1080p.
    result(
      'typing in the Subtitles tab changes the line in the player, as wide as the creator’s',
      before.length === 3 && /following the transcript/.test(status) && live === 'Come out of the bathroom!' && Math.abs(m.width - 640) < 12,
      `${before.length} lines, "${status}", player "${live}", ${m.width.toFixed(0)} px wide`,
    );
  }

  // 5. Edits survive a reload; Rebuild goes back to the transcript, and undoes.
  {
    await open();
    const saved = await page.eval(`JSON.stringify(${E}.getState().project.subtitles?.map((s) => s.text))`);
    await page.eval(`[...document.querySelectorAll('[role=tab]')].find((t) => t.textContent === 'Subtitles').click()`);
    await sleep(300);
    await page.eval(`document.querySelector('[data-testid=follow-transcript]').click()`);
    await sleep(300);
    const rebuilt = (await panelLines())[0];
    await page.eval(`${E}.getState().undo()`);
    await sleep(300);
    const undone = (await panelLines())[0];
    result(
      'an edited line survives a reload, Rebuild restores the transcript, and undo brings the edit back',
      JSON.parse(saved)?.[0] === 'Come out of the bathroom!' && rebuilt === "Okay, let's split up." && undone === 'Come out of the bathroom!',
      `saved ${saved}; rebuilt "${rebuilt}"; undone "${undone}"`,
    );
  }

  // 6. Deleting a line takes it off the video.
  {
    await page.eval(`document.querySelectorAll('[data-testid=subtitles-panel] [aria-label="Delete subtitle"]')[1].click()`);
    await sleep(300);
    await seek(await outFrame(4.6));
    const gone = await shown();
    result('a deleted line no longer shows', gone === null && (await panelLines()).length === 2, `4.6 s ${JSON.stringify(gone)}`);
  }

  // 7. The default look has its own style.
  {
    await setLook('default');
    await seek(await outFrame(1.4));
    const m = await measure();
    result('the default look draws its own subtitle style', m.weight === '600' && Math.abs(m.size - 44) < 0.5, `${m.size.toFixed(1)} px, weight ${m.weight}`);
  }

  const errors = page.logs.filter((l) => /\[(error|exception)\]/.test(l));
  result('no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} finally {
  page.close();
}
