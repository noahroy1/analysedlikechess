// Runs the trial in headless Chrome at a phone's size, the way the user will on the phone:
// tap Play and watch it through, pause and resume once, jump (a seek), then print the report.
// Usage: node mac-check.mjs [url] [screenshot dir]   (needs `pnpm preview` running)
import { launch, sleep } from '../../scripts/browser/cdp.mjs';

const url = process.argv[2] ?? 'http://127.0.0.1:4173/';
const shots = process.argv[3];
const page = await launch({ port: 9341, profile: `${process.env.TMPDIR}/als-trial-chrome`, width: 390, height: 844 });
const tap = async (id) => {
  const r = JSON.parse(await page.eval(`JSON.stringify(document.querySelector('[data-testid=${id}]').getBoundingClientRect())`));
  await page.click(r.x + r.width / 2, r.y + r.height / 2);
};
const P = 'window.__alsPlayer';
try {
  await page.goto(url);
  await page.waitFor(`document.querySelector('[data-testid=play]') && !document.querySelector('[data-testid=play]').disabled`, 60000);
  const out = await page.eval(`(() => ${P}.getDuration?.() ?? 0)()`);
  console.log('ready; frames', out);
  // 1. First tap, through to the end.
  await tap('play');
  await sleep(1500);
  if (shots) await page.screenshot(`${shots}/chrome-playing.png`);
  await page.waitFor(`!${P}.isPlaying()`, 120000);
  await sleep(1000);
  // 2. Restart, pause after 3 s, resume to the end.
  await tap('restart');
  await sleep(3000);
  await tap('pause');
  await sleep(1000);
  await tap('play');
  await page.waitFor(`!${P}.isPlaying()`, 120000);
  await sleep(800);
  // 3. Jump (a seek) and play to the end.
  await tap('jump');
  await sleep(500);
  await page.waitFor(`!${P}.isPlaying()`, 120000);
  await sleep(1000);
  await tap('refresh');
  await sleep(800);
  if (shots) await page.screenshot(`${shots}/chrome-report.png`);
  console.log(await page.eval(`document.querySelector('[data-testid=report]').textContent`));
  const errors = page.logs.filter((l) => /error|exception|fallback/i.test(l));
  if (errors.length) console.log(errors.slice(0, 10).join('\n'));
} finally {
  await page.close();
}
