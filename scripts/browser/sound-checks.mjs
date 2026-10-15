// Chess sound checks against a running `pnpm dev`, in headless Chrome.
// usage: node scripts/browser/sound-checks.mjs <scratchDir> <projectsDir> <projectId>
// Use a project seeded from the fixture (`pnpm seed:sample`) and sounds in the
// server's sounds folder (`media/sounds`). The check strips the audio from that
// project's proxy, so every sound the Player schedules is a chess sound, then
// plays the whole episode in Preview and compares what Web Audio was asked to
// play, and when, with `soundCues()`. Headless Chrome cannot be listened to;
// this checks the schedule.
import { execFileSync } from 'node:child_process';
import { renameSync } from 'node:fs';
import { join } from 'node:path';
import { gameReviewSec } from '../../packages/schema/src/game-review.ts';
import { buildTimeline } from '../../packages/composition/src/timeline.ts';
import { soundCues } from '../../packages/composition/src/sounds.ts';
import { launch, sleep } from './cdp.mjs';

const [S, projectsDir, projectId] = process.argv.slice(2);
const P = 'window.__alsPlayer';
const E = 'window.__alsEditor';
const result = (name, ok, detail = '') => console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
/** Frames a scheduled sound may sit from its cue: the Player's frame clock and Web Audio's run apart by a frame or two. */
const SLACK = 3;

const editorState = async () =>
  JSON.parse(await page.eval(`JSON.stringify((({ project, doc, theme }) => ({ source: project.source, moments: doc.moments, characters: doc.characters, theme }))(${E}.getState()))`));

const proxy = join(projectsDir, projectId, 'proxy.mp4');
execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', proxy, '-an', '-c', 'copy', `${proxy}.silent.mp4`]);
renameSync(`${proxy}.silent.mp4`, proxy);

const page = await launch({ profile: `${S}/chrome-sounds`, width: 1500, height: 1150 });
// Logs every buffer Web Audio is asked to play, with the Player frame it lands on.
await page.send('Page.addScriptToEvaluateOnNewDocument', {
  source: `
    window.__soundLog = [];
    const start = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (when = 0, offset = 0, duration) {
      const p = window.__alsPlayer;
      // Logged even before the Player reports playing: frame 0's sounds are scheduled while the context resumes.
      if (p) {
        const fps = window.__alsEditor.getState().project.source.fps;
        const ahead = Math.max(0, when - this.context.currentTime);
        window.__soundLog.push({ frame: p.getCurrentFrame() + ahead * fps, offset, length: this.buffer ? this.buffer.duration : 0 });
      }
      return start.apply(this, arguments);
    };
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      if (this.tagName === 'AUDIO') window.__soundLog.push({ html5: this.currentSrc, frame: window.__alsPlayer?.getCurrentFrame() });
      return play.apply(this, arguments);
    };`,
});

try {
  await page.goto(`http://localhost:5173/#/projects/${projectId}`);
  await page.waitFor(`!!${P} && !!${E}`);
  await sleep(1000);
  const sounds = await (await fetch('http://localhost:5173/api/sounds')).json();

  // 1. The server lists the sounds and serves them.
  {
    const ids = Object.keys(sounds);
    const fetched = await Promise.all(Object.values(sounds).map(async (s) => (await fetch(`http://localhost:5173${s.src}`)).ok));
    result('the server lists the sounds folder and serves every file', ids.length > 0 && fetched.every(Boolean), `${ids.length} sounds: ${ids.join(', ')}`);
  }

  /** Plays the whole episode under the current look and checks its sounds. */
  const playThrough = async (look) => {
    const state = await editorState();
    const { fps, durationSec } = state.source;
    const timeline = buildTimeline(state.moments, fps, durationSec, gameReviewSec(state.theme));
    const cues = soundCues({ timeline, moments: state.moments, characters: state.characters, timing: state.theme.timing, sounds });

    // Play the whole episode straight through, as the MP4 will.
    await page.eval(`[...document.querySelectorAll('[aria-label="Playback mode"] button')].find((b) => b.textContent.trim() === 'preview').click()`);
    await page.eval(`${P}.pause(); ${P}.seekTo(0); window.__soundLog.length = 0; ${P}.play()`);
    await page.waitFor(`!${P}.isPlaying() || ${P}.getCurrentFrame() >= ${timeline.outFrames - 2}`, (timeline.outFrames / fps) * 1000 + 15000);
    await sleep(800);
    const log = JSON.parse(await page.eval('JSON.stringify(window.__soundLog)'));
    const html5 = log.filter((l) => l.html5);
    const starts = log.filter((l) => !l.html5);

    // 2. Every cue is scheduled on its frame.
    {
      const misses = [];
      const deltas = [];
      for (const cue of cues) {
        const near = starts.filter((s) => Math.abs(s.frame - cue.from) <= SLACK);
        if (near.length === 0) misses.push(`${cue.key} @${cue.from}`);
        else deltas.push(Math.min(...near.map((s) => Math.abs(s.frame - cue.from))));
      }
      const worst = deltas.length ? Math.max(...deltas).toFixed(1) : '-';
      result(`${look}: every cue plays within a few frames of its frame, through Web Audio`, misses.length === 0 && html5.length === 0, `${cues.length} cues, ${starts.length} buffers, worst ${worst} frames${misses.length ? `; missing ${misses.join(', ')}` : ''}${html5.length ? `; ${html5.length} fell back to <audio>` : ''}`);
    }

    // 3. Each hold: the move sound on the badge, typing from the first word to the last, then silence for the reread.
    {
      const rows = [];
      let ok = true;
      for (const hold of timeline.holds) {
        const id = hold.momentId;
        const own = cues.filter((c) => c.key.startsWith(`${id}:`));
        const move = own.find((c) => c.key === `${id}:move`);
        const typingEnd = Math.max(...own.filter((c) => c.sound.startsWith('typing')).map((c) => c.from + c.frames));
        const inReread = starts.filter((s) => s.frame > typingEnd + SLACK && s.frame < hold.outStart + hold.frames - SLACK);
        const holdOk = !!move && move.from === hold.outStart + Math.round(state.theme.timing.badgeDelaySec * fps) && inReread.length === 0;
        ok &&= holdOk;
        rows.push(`${id}: ${move?.sound} +${move ? move.from - hold.outStart : '?'}f, ${own.filter((c) => c.sound.startsWith('typing-space')).length} spaces, typing to +${typingEnd - hold.outStart}f of ${hold.frames}${inReread.length ? `, ${inReread.length} in reread` : ''}`);
      }
      result(`${look}: each hold: move sound on the badge, typing under the type-out, a silent reread`, ok, rows.join('; '));
    }

    // 4. The game sounds bracket the clip; a game review follows in silence.
    {
      const start = cues.find((c) => c.key === 'game-start');
      const end = cues.find((c) => c.key === 'game-end');
      const ten = cues.find((c) => c.key === 'ten-seconds');
      const last = timeline.gameReview?.outStart ?? timeline.outFrames;
      const inReview = starts.filter((s) => s.frame > last + SLACK);
      const ok = start?.from === Math.round(fps) && end && end.from + end.frames === last && ten?.from === last - 10 * fps && inReview.length === 0;
      result(
        `${look}: game-start 1 s in, the ten-second warning 10 s out, game-end finishing on the clip's last frame${timeline.gameReview ? ', a silent review after it' : ''}`,
        !!ok,
        `start ${start?.from}, ten ${ten?.from}, end ${end?.from}+${end?.frames} of ${last}, video ${timeline.outFrames}${inReview.length ? `, ${inReview.length} in the review` : ''}`,
      );
    }
  };

  // 2-4 under the default look (badge in the card), then the creator's (badge pops at 0.3 s).
  await playThrough('default');
  await page.eval(`(() => {
    const sel = document.querySelector('[data-testid=theme-picker]');
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, 'creator');
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await sleep(500);
  await playThrough('creator');

  const errors = page.logs.filter((l) => /\[(error|exception)\]/.test(l));
  result('no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} finally {
  page.close();
}
