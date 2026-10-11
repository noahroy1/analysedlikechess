// Type-out checks against a running `pnpm dev`, in headless Chrome.
// usage: node scripts/browser/typeout-checks.mjs <scratchDir> <projectId> <momentId> [screenshotPrefix]
// Seeks through one hold and reads the card the Player draws: the explanation
// types out word by word at the theme's speed, the best move waits for the last
// word, and the card is complete for the reread.
import { launch, sleep } from './cdp.mjs';

const [S, projectId, momentId, shots] = process.argv.slice(2);
const P = 'window.__alsPlayer';
const E = 'window.__alsEditor';
const result = (name, ok, detail = '') => console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);

const page = await launch({ profile: `${S}/chrome-typeout`, width: 1680, height: 1150 });
try {
  await page.goto(`http://localhost:5173/#/projects/${projectId}`);
  await page.waitFor(`!!${P} && !!${E}`);
  await sleep(1200);
  // Preview mode, so nothing pauses the Player for editing.
  await page.eval(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Preview')?.click()`);

  const info = JSON.parse(
    await page.eval(`(() => {
      const s = ${E}.getState();
      const m = s.doc.moments.find((x) => x.id === '${momentId}');
      const t = s.theme.timing;
      const words = m.explanation.trim().split(/\\s+/).length;
      return JSON.stringify({ m, t, words });
    })()`),
  );
  const { m, t, words } = info;
  const holds = JSON.parse(await page.eval(`JSON.stringify([...document.querySelectorAll('[data-testid=hold-block]')].map((b) => ({ id: b.dataset.momentId, start: Number(b.dataset.outStart), frames: Number(b.dataset.frames) })))`));
  const hold = holds.find((h) => h.id === momentId);
  if (!hold) throw new Error(`no hold block for ${momentId}: ${JSON.stringify(holds)}`);
  const fps = await page.eval(`fetch('/api/projects/${projectId}').then((r) => r.json()).then((p) => p.source.fps)`);

  const read = async (sec) => {
    const frame = hold.start + Math.round(sec * fps);
    await page.eval(`${P}.pause(); ${P}.seekTo(${frame})`);
    await sleep(250);
    return JSON.parse(
      await page.eval(`(() => {
        const card = document.querySelector('.__remotion-player [data-moment-id="${momentId}"]');
        if (!card) return JSON.stringify(null);
        const spans = [...card.querySelectorAll('p > span')];
        return JSON.stringify({
          words: spans.length,
          last: spans.length ? Number(getComputedStyle(spans.at(-1)).opacity) : null,
          text: spans.map((s) => s.textContent.trim()).join(' '),
          best: card.textContent.includes(${JSON.stringify(m.bestMove ?? '\u0000')}),
        });
      })()`),
    );
  };

  const wps = t.typeOut.wordsPerSec;
  const typingEnd = t.cardInSec + (words - 1) / wps + t.typeOut.wordFadeSec;
  const samples = [];
  for (let sec = 0; sec <= typingEnd + 0.6; sec += 0.25) samples.push({ sec, ...(await read(sec)) });
  if (shots) {
    // The edit layer covers a paused hold with the full, editable card; hide it to see the drawn frame.
    await page.eval(`document.head.insertAdjacentHTML('beforeend', '<style>[data-testid=edit-layer]{display:none!important}</style>')`);
    for (const [i, sec] of [t.cardInSec + 1, t.cardInSec + typingEnd / 2, typingEnd + 0.5].entries()) {
      await read(sec);
      await page.screenshot(`${shots}-${i}.png`, { x: 390, y: 70, width: 830, height: 470 });
    }
  }

  // The last frame before the card is fully in.
  const beforeIn = await read(t.cardInSec - 1 / fps);
  result('no explanation words before the card is in', beforeIn !== null && beforeIn.words === 0, `${beforeIn?.words} words a frame before ${t.cardInSec} s`);

  const typing = samples.filter((s) => s.sec > t.cardInSec && s.sec < typingEnd - 0.2);
  const expected = (sec) => Math.min(words, Math.floor((sec - t.cardInSec) * wps) + 1);
  const offBy = Math.max(...typing.map((s) => Math.abs(s.words - expected(s.sec))));
  const monotonic = typing.every((s, i) => i === 0 || s.words >= typing[i - 1].words);
  result(`types out at ${wps} words a second`, monotonic && offBy <= 1, `${typing.map((s) => s.words).join(', ')} words at 0.25 s steps; max off by ${offBy}`);

  const final = samples.at(-1);
  result('the whole explanation is in by the end of the type-out', final.words === words && final.last === 1 && final.text === m.explanation.trim().split(/\s+/).join(' '), `${final.words}/${words} words`);

  if (m.bestMove) {
    const early = typing.some((s) => s.best);
    result('the best move appears only after the last word', !early && final.best, `during typing: ${early}, after: ${final.best}`);
  }

  const holdSec = hold.frames / fps;
  result('the finished card stays for the reread', Math.abs(holdSec - typingEnd - t.rereadSec - t.cardOutSec) < 0.15, `hold ${holdSec.toFixed(2)} s, typing done at ${typingEnd.toFixed(2)} s, reread ${t.rereadSec} s`);
} finally {
  page.close();
}
