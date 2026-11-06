// C5's checks in the iOS simulator, against local dev (PLAN-CLOUD.md, C5). No dependencies.
//
//   ANALYSIS_REPLAY_DIR=$PWD/fixtures/dialogue/recorded RENDER_CHUNK_MIN_FRAMES=250 pnpm dev      (once, from the root)
//   CHECK_BRIDGE=http://127.0.0.1:8791 node apps/mobile/scripts/ios.ts run local --simulator
//   node apps/mobile/scripts/sim-checks.mjs <scratchDir> <bigClip.mp4> [simulator]
//
// The app built with CHECK_BRIDGE polls this script for snippets to run (src/lib/check-bridge.ts). Checks:
// 1. sign-in by the emailed link: local Supabase's email (Mailpit), its link followed to the app's URL scheme, opened
//    in the simulator; 2. an upload of <bigClip> (several hundred MB, so it spans many 8 MiB parts) sent to the
//    background part way and brought back: it carries on from the parts stored; 3. ingest and the replayed analysis
//    give drafts; 4. the Player plays and stops at the first card; 5. a card's label is edited and the move approved
//    through the sheet, and both are saved; 6. a render finishes and Share downloads it and opens the share sheet.
// Screenshots go to <scratchDir>. <bigClip> should be the dialogue fixture re-encoded large (the replayed analysis
// answers belong to it), e.g. ffmpeg -i fixtures/dialogue/source.mp4 -vf "scale=1920:-2,noise=alls=12:allf=t"
// -c:v libx264 -preset ultrafast -qp 24 -c:a copy big.mp4 (about 470 MB).
//
// On staging instead (the phone's backend, without the phone; nothing paid runs):
//   CHECK_BRIDGE=http://127.0.0.1:8791 node apps/mobile/scripts/ios.ts run staging --simulator
//   CHECK_ENV=staging CHECK_OWNER=<email> node apps/mobile/scripts/sim-checks.mjs <scratchDir> --staging <projectId> [simulator]
// signs in as the owner with a minted session, opens the project, and checks that the clip plays from R2 across
// origins (signed media, CORS), the chess sounds load, and Review stops at the first card.
import { execFileSync } from 'node:child_process';
import { createReadStream, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';

const args = process.argv.slice(2);
const staging = args[1] === '--staging' ? args[2] : undefined;
const [scratch, clip] = args;
const simulator = (staging ? args[3] : args[2]) ?? 'iPhone 17';
if (!scratch || !clip || (args[1] === '--staging' && !staging)) {
  console.error('usage: node apps/mobile/scripts/sim-checks.mjs <scratchDir> (<bigClip.mp4> | --staging <projectId>) [simulator]');
  process.exit(2);
}
const ROOT = new URL('../../../', import.meta.url).pathname;
const PORT = 8791;
const BASE = `http://127.0.0.1:${PORT}`;
const MAILPIT = 'http://127.0.0.1:54324';
const BUNDLE_ID = 'com.noahroy.alstrial';
const devEmail = /^VITE_DEV_EMAIL=(.*)$/m.exec(readFileSync(join(ROOT, 'apps/web/.env.development.local'), 'utf8'))?.[1]?.trim();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const report = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `: ${detail}` : ''}`);
};
const simctl = (...args) => execFileSync('xcrun', ['simctl', ...args], { encoding: 'utf8' });
const screenshot = (name) => simctl('io', simulator, 'screenshot', join(scratch, `sim-${name}.png`));

// The bridge: a queue of snippets the app fetches, and their results.
const queue = [];
const waiting = new Map();
let polled = false;
let nextId = 0;
const server = createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.url === '/next') {
    polled = true;
    const job = queue.shift();
    if (!job) return res.writeHead(204).end();
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(job));
  } else if (req.url === '/result' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const { id, result, error } = JSON.parse(body);
      waiting.get(id)?.(error ? { error } : { result });
      waiting.delete(id);
      res.writeHead(204).end();
    });
  } else if (req.url === '/clip') {
    res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': statSync(clip).size });
    createReadStream(clip).pipe(res);
  } else res.writeHead(404).end();
});
server.listen(PORT, '127.0.0.1');

/** Runs `js` (an async function body) in the app and returns what it returns. */
function run(js, timeoutMs = 30_000) {
  const id = String(++nextId);
  queue.push({ id, js });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out: ${js.slice(0, 80)}`)), timeoutMs);
    waiting.set(id, (r) => {
      clearTimeout(timer);
      if (r.error) reject(new Error(r.error));
      else resolve(r.result);
    });
  });
}

async function until(what, fn, timeoutMs, everyMs = 1000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn().catch(() => undefined);
    if (value) return value;
    if (Date.now() > end) throw new Error(`gave up waiting for ${what}`);
    await sleep(everyMs);
  }
}

// In-app helpers: click by test id or text, and type into a React input.
const DOM = `
  const q = (sel) => document.querySelector(sel);
  const byText = (text) => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === text);
  const type = (el, value) => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
`;

async function stagingChecks(projectId) {
  const { currentSession } = await import('../../../scripts/browser/dev-api.mjs');
  const s = await currentSession();
  await run(`await __als.session.supabase.auth.setSession(${JSON.stringify({ access_token: s.access_token, refresh_token: s.refresh_token })}); location.hash = '#/p/${projectId}';`);
  const listed = await until('the editor', () => run(`return document.querySelectorAll('[data-testid=moves] li').length > 0 && window.__alsPlayer ? document.querySelectorAll('[data-testid=moves] li').length : 0;`), 60_000).catch(() => 0);
  report('the staging project opens in the editor', listed > 0, `${listed} moves`);
  const sounds = await run(`const bank = await __als.api.getSoundBank(); return Object.keys(bank.sounds ?? bank).length;`).catch((e) => `error ${e.message}`);
  report('the chess sounds load (signed URLs)', typeof sounds === 'number' && sounds > 0, String(sounds));
  await run(`__alsPlayer.seekTo(0); await new Promise((r) => setTimeout(r, 800)); document.querySelector('[data-testid=play]').click();`);
  const stopped = await until('the first card stop', () => run(`return !__alsPlayer.isPlaying() && document.querySelector('[data-testid=edit-card]') ? __alsPlayer.getCurrentFrame() : 0;`), 120_000, 500).catch(() => 0);
  report('it plays, and Review stops at the first card', stopped > 0, `frame ${stopped}`);
  await sleep(1500);
  screenshot('staging-card');
  // Play on through the hold: frames keep coming from R2.
  const played = await run(`const from = __alsPlayer.getCurrentFrame(); document.querySelector('[data-testid=play]').click(); await new Promise((r) => setTimeout(r, 4000)); __alsPlayer.pause(); return __alsPlayer.getCurrentFrame() - from;`, 60_000);
  report('the clip plays on from R2 across origins', played > 60, `${played} frames in 4 s`);
  await sleep(500);
  screenshot('staging-played');
}

try {
  await until('the app to poll the bridge (built with CHECK_BRIDGE?)', async () => polled, 60_000, 500);
  if (staging) {
    await stagingChecks(staging);
    throw Object.assign(new Error('done'), { done: true });
  }

  // 1. Sign-in by the emailed link.
  {
    await run(`await __als.session.signOut(); location.hash = '#/';`);
    const since = Date.now();
    await run(`await __als.session.sendCode(${JSON.stringify(devEmail)}, __als.AUTH_REDIRECT);`);
    const message = await until(
      'the sign-in email',
      async () => {
        const list = await (await fetch(`${MAILPIT}/api/v1/messages?limit=5`)).json();
        return list.messages.find((m) => m.To.some((t) => t.Address === devEmail) && Date.parse(m.Created) >= since - 2000);
      },
      30_000,
    );
    const html = (await (await fetch(`${MAILPIT}/api/v1/message/${message.ID}`)).json()).HTML;
    const link = /href="([^"]*\/auth\/v1\/verify[^"]*)"/.exec(html)?.[1]?.replaceAll('&amp;', '&');
    const res = link ? await fetch(link, { redirect: 'manual' }) : undefined;
    const location = res?.headers.get('location') ?? '';
    report('the email link redirects to the app with a code', location.startsWith('com.noahroy.alstrial://auth/callback?code='), location.slice(0, 60));
    simctl('openurl', simulator, location);
    const signedIn = await until('the session', () => run(`return Boolean(await __als.session.session());`), 20_000).catch(() => false);
    report('the app signs in from the link (PKCE exchange)', signedIn);
    await sleep(1500);
    screenshot('1-signed-in');
  }

  // 2. Upload, backgrounded part way, then back.
  let projectId;
  {
    await run(`
      window.__uploadLog = [];
      __als.subscribeUpload(() => { const s = __als.getUpload(); if (s) __uploadLog.push({ t: Date.now(), status: s.status, progress: s.progress, projectId: s.projectId, error: s.error }); });
      const blob = await (await fetch(${JSON.stringify(`${BASE}/clip`)})).blob();
      __als.upload.start(new File([blob], 'dialogue-big.mp4', { type: 'video/mp4' }), { movieTitle: 'Sim check' });
    `, 120_000);
    const before = await until('a quarter of the upload', async () => {
      const s = await run(`return __als.getUpload();`);
      return s && s.progress >= 0.25 ? s.progress : undefined;
    }, 120_000, 200);
    screenshot('2-uploading');
    // The simulator keeps a backgrounded app's connections (a phone drops them), so stay away only briefly:
    // coming back still restarts the upload, which must carry on from the parts the server has.
    simctl('launch', simulator, 'com.apple.Preferences');
    await sleep(1500);
    simctl('launch', simulator, BUNDLE_ID);
    const done = await until('the upload to finish', async () => {
      const s = await run(`return __als.getUpload() ?? (window.__uploadLog.at(-1));`);
      return s?.status === 'done' ? s : s?.status === 'failed' ? { failed: s.error } : undefined;
    }, 300_000, 1000);
    const log = await run(`return window.__uploadLog;`);
    const away = log.find((e) => e.status === 'paused');
    const resumedAt = log.findIndex((e, i) => i > 0 && e.status === 'uploading' && log[i - 1].status !== 'uploading');
    // The lowest progress after the restart: 0 would mean it sent everything again.
    const firstAfter = resumedAt >= 0 ? Math.min(...log.slice(resumedAt).map((e) => e.progress)) : undefined;
    report('the upload finishes after the app was sent to the background', done.status === 'done', done.failed ?? '');
    report(
      'coming back, it carries on from the parts stored (not from 0)',
      firstAfter !== undefined && firstAfter >= before - 0.02,
      `${Math.round(before * 100)}% before, ${firstAfter === undefined ? 'no restart seen' : `${Math.round(firstAfter * 100)}%`} at the restart${away ? ', paused while away' : ''}`,
    );
    projectId = done.projectId;
  }

  // 3. Ingest and the replayed analysis.
  {
    const project = await until('drafts', async () => {
      const p = await run(`const p = await __als.api.getProject(${JSON.stringify(projectId)}); return { ingest: p.ingest.status, analysis: p.analysis.status, moves: p.moments.length };`);
      if (p.ingest === 'error' || p.analysis === 'error') return p;
      return p.ingest === 'done' && p.analysis === 'done' ? p : undefined;
    }, 600_000, 3000);
    report('ingest and analysis finish with drafts', project.analysis === 'done' && project.moves > 0, `${project.moves} moves`);
  }

  // 4. Playback: plays, then stops at the first card.
  {
    const listed = await until('the moves list', () => run(`${DOM} const n = document.querySelectorAll('[data-testid=moves] li').length; return n > 0 && window.__alsPlayer ? n : 0;`), 60_000);
    report('the editor lists the drafts', listed > 0, `${listed}`);
    const start = await run(`${DOM} __alsPlayer.seekTo(0); await new Promise((r) => setTimeout(r, 500)); q('[data-testid=play]').click(); await new Promise((r) => setTimeout(r, 2500)); return __alsPlayer.getCurrentFrame();`);
    report('the Player plays', start > 20, `frame ${start} after 2.5 s`);
    const stopped = await until('the first card stop', () => run(`${DOM} return !__alsPlayer.isPlaying() && q('[data-testid=edit-card]') ? __alsPlayer.getCurrentFrame() : 0;`), 60_000, 500).catch(() => 0);
    report('Review stops at the first card', stopped > 0, `frame ${stopped}`);
    await sleep(800);
    screenshot('4-card');
  }

  // 5. Edit a label, approve, and both save.
  {
    await run(`${DOM} q('[data-testid=edit-card]').click();`);
    await sleep(600);
    const label = 'Sim check move';
    await run(`${DOM} type(q('[data-testid=move-label]'), ${JSON.stringify(label)}); q('[data-testid=approve]').click();`);
    await sleep(500);
    screenshot('5-sheet');
    const saved = await until('the save', () => run(`${DOM} return q('[data-testid=save-status]').textContent === 'Saved';`), 20_000, 500).catch(() => false);
    const server = await run(`const p = await __als.api.getProject(${JSON.stringify(projectId)}); return p.moments.find((m) => m.moveLabel === ${JSON.stringify(label)})?.status;`);
    report('the label edit and approval are saved', saved && server === 'approved', `server: ${server ?? 'label not found'}`);
    await run(`${DOM} byText('Done')?.click();`);
  }

  // 6. Render, then Share.
  {
    await run(`${DOM} byText('Render').click();`);
    await sleep(500);
    await run(`${DOM} q('[data-testid=render-start]').click();`);
    const done = await until('the render', () => run(`${DOM} return Boolean(q('[data-testid=render-share]'));`), 600_000, 2000).catch(() => false);
    report('the render finishes', done);
    if (done) {
      await run(`${DOM} q('[data-testid=render-share]').click();`);
      const shared = await until('the share sheet', () => run(`${DOM} return q('[data-testid=render-share]').textContent.trim() === 'Preparing 100%';`), 120_000, 500).catch(() => false);
      await sleep(2500);
      screenshot('6-share');
      report('Share downloads the MP4 and opens the share sheet (see sim-6-share.png)', shared);
    }
  }
} catch (error) {
  if (!error.done) report('checks ran to the end', false, error.message);
} finally {
  server.close();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}
