import './hooks.ts';
import { Episode, buildTimeline, soundCues, timeMapFrame, type SoundCue, type Timeline } from '@als/composition';
import { adoptProjectLook, normalize, type Doc } from '@als/editor-core';
import { episodeProps, gameReviewSec, projectFormat, type EpisodeProps, type Project, type SoundBank } from '@als/schema';
import { PROJECT_THEME_ID, getTheme } from '@als/theme';
import { Player, type PlayerRef } from '@remotion/player';
import { useEffect, useMemo, useRef, useState, type SyntheticEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { consoleLog, contexts, live, soundLog } from './hooks.ts';

declare const __REPORT_URL__: string;

// ---- Measurement state (module level: the sampler runs outside React) ----

type SpanKind = 'first tap' | 'resume' | 'seek';
interface Sample {
  t: number;
  /** Mean brightness of the video layer, 0-255 (hold samples only). */
  mean?: number;
  frame: number;
  hash?: number;
  diff?: number;
}
interface Span {
  kind: SpanKind;
  t0: number;
  t1?: number;
  startFrame: number;
  endFrame?: number;
  samples: Sample[];
}
interface HoldRef {
  momentId: string;
  outStart: number;
  frames: number;
  sourceFrame: number;
  ref?: Uint8ClampedArray;
  /** A paused seek inside the hold against the reference (same source frame, other segment). */
  pausedDiff?: number;
  /** The play frame before the hold (the previous source frame) against the reference: the control. */
  controlDiff?: number;
  refFrame?: number;
}

const spans: Span[] = [];
const holdRefs: HoldRef[] = [];
const layerKinds = new Set<string>();
const inline = { fullscreenEvents: 0, videoFullscreen: false, overflowed: false };
const review = { seen: false, visibleAt: undefined as number | undefined, summary: '' };
let nextKind: SpanKind = 'first tap';
let pendingT0: number | undefined;
/** Set by Restart and Jump: the next play is after a seek, whatever pause comes first. */
let forceKind: SpanKind | undefined;

const small = document.createElement('canvas');
small.width = 32;
small.height = 18;
const sctx = small.getContext('2d', { willReadFrequently: true })!;

/** The element the video frame is drawn on: the Mediabunny <canvas>, or the fallback's <video>. */
function videoLayer(): HTMLCanvasElement | HTMLVideoElement | undefined {
  const root = document.querySelector('.__remotion-player');
  if (!root) return undefined;
  const els = [...root.querySelectorAll<HTMLCanvasElement | HTMLVideoElement>('canvas, video')].filter(
    (e) => e.offsetParent !== null && getComputedStyle(e).opacity !== '0' && (e instanceof HTMLCanvasElement ? e.width > 0 : e.videoWidth > 0),
  );
  return els.at(-1);
}

function pixels(): Uint8ClampedArray | undefined {
  const el = videoLayer();
  if (!el) return undefined;
  layerKinds.add(el.tagName.toLowerCase());
  sctx.clearRect(0, 0, 32, 18);
  sctx.drawImage(el, 0, 0, 32, 18);
  return sctx.getImageData(0, 0, 32, 18).data.slice();
}

const hashOf = (d: Uint8ClampedArray) => {
  let h = 2166136261;
  for (let i = 0; i < d.length; i++) if (i % 4 !== 3) h = Math.imul(h ^ d[i]!, 16777619) >>> 0;
  return h;
};
/** Mean absolute difference per channel, 0-255. */
const diffOf = (a: Uint8ClampedArray, b: Uint8ClampedArray) => {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < a.length; i++) if (i % 4 !== 3) (sum += Math.abs(a[i]! - b[i]!)), n++;
  return sum / n;
};

const meanOf = (d: Uint8ClampedArray) => {
  let sum = 0;
  for (let i = 0; i < d.length; i += 4) sum += d[i]! + d[i + 1]! + d[i + 2]!;
  return sum / (d.length / 4) / 3;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Seeks the paused Player and waits for the video layer to settle on the new frame. */
async function seekAndGrab(player: PlayerRef, frame: number): Promise<Uint8ClampedArray | undefined> {
  player.seekTo(frame);
  await sleep(250);
  let prev = pixels();
  for (let i = 0; i < 30; i++) {
    await sleep(100);
    const next = pixels();
    if (prev && next && hashOf(prev) === hashOf(next)) return next;
    prev = next;
  }
  return prev;
}

// ---- Report ----

const SLACK = 2;
const MATCH = 6;

interface Report {
  lines: string[];
  data: Record<string, unknown>;
}

function buildReport(env: Record<string, unknown>, timeline: Timeline, cues: SoundCue[], fps: number): Report {
  const lines: string[] = [];
  const line = (ok: boolean | 'info', name: string, detail = '') => lines.push(`${ok === 'info' ? 'INFO' : ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  const closed = spans.filter((s) => s.endFrame !== undefined);

  // 1. Decoding path.
  const kinds = [...layerKinds];
  line('info', 'decoding path', `${kinds.includes('canvas') && !kinds.includes('video') ? 'WebCodecs <canvas>' : kinds.includes('video') ? 'fallback <video>' : 'none seen'}; VideoDecoder ${env.VideoDecoder}, AudioDecoder ${env.AudioDecoder}; layers seen: ${kinds.join(', ') || '-'}`);

  // 2. Inline.
  line(inline.fullscreenEvents === 0 && !inline.videoFullscreen && !inline.overflowed, 'the video plays in the page, never full screen', `${inline.fullscreenEvents} fullscreen events${inline.overflowed ? ', player wider than the page' : ''}`);

  // 3. Holds.
  const holds = holdRefs.map((h) => {
    const inside = closed.flatMap((s) => s.samples).filter((s) => s.frame >= h.outStart + 1 && s.frame <= h.outStart + h.frames - 2 && s.hash !== undefined);
    const diffs = inside.map((s) => s.diff ?? NaN).filter((d) => !Number.isNaN(d));
    // Each image seen, with how often and its brightness, so a blank read stands apart from a wrong frame.
    const images = new Map<number, { count: number; mean: number; diff: number; frames: number[] }>();
    for (const s of inside) {
      const img = images.get(s.hash!) ?? { count: 0, mean: Math.round(s.mean ?? -1), diff: Math.round((s.diff ?? NaN) * 100) / 100, frames: [] };
      img.count++;
      if (img.frames.length < 12) img.frames.push(s.frame);
      images.set(s.hash!, img);
    }
    const ranked = [...images.values()].sort((a, b) => b.count - a.count);
    const main = ranked[0];
    return { ...h, ref: undefined, n: inside.length, distinct: images.size, playDiff: diffs.length ? Math.max(...diffs) : undefined, mainDiff: main?.diff, images: ranked };
  });
  line(
    holds.length > 0 && holds.every((h) => h.n > 0 && h.distinct === 1),
    'each hold shows one frozen image for its whole length',
    holds.map((h) => `${h.momentId}: ${h.n} samples, ${h.distinct} distinct [${h.images.map((i) => `${i.count}x mean ${i.mean} diff ${i.diff}${i.count < 20 ? ` at ${i.frames.join(',')}` : ''}`).join('; ')}]`).join(' | '),
  );
  const exact = (d?: number) => d !== undefined && d <= 2;
  line(
    holds.length > 0 && holds.every((h) => exact(h.pausedDiff) && exact(h.mainDiff) && (h.controlDiff ?? 0) > (h.mainDiff ?? 0)),
    "each hold's image is the source frame buildTimeline() names",
    holds
      .map((h) => `${h.momentId} (src ${h.sourceFrame}, ref out ${h.refFrame}): paused ${h.pausedDiff?.toFixed(2)}, playing (main image) ${h.mainDiff}, worst ${h.playDiff?.toFixed(2)}, prev-frame control ${h.controlDiff?.toFixed(2)}`)
      .join('; '),
  );

  // 4. Sounds, per kind of start.
  const soundRows = closed.map((s) => {
    const starts = soundLog.filter((l) => l.t >= s.t0 - 200 && l.t <= s.t1! + 200);
    const expected = cues.filter((c) => c.from > s.startFrame + 1 && c.from < s.endFrame! - SLACK);
    const missing: string[] = [];
    const deltas: number[] = [];
    for (const cue of expected) {
      const near = starts.filter((l) => !l.html5 && l.contextState === 'running' && Math.abs(l.frame - cue.from) <= MATCH);
      if (near.length === 0) missing.push(`${cue.key}@${cue.from}`);
      else deltas.push(Math.min(...near.map((l) => Math.abs(l.frame - cue.from))));
    }
    const html5 = starts.filter((l) => l.html5).length;
    const html5Srcs = [...new Set(starts.filter((l) => l.html5).map((l) => l.html5!.slice(0, 80)))];
    const suspended = starts.filter((l) => l.contextState && l.contextState !== 'running').length;
    const worst = deltas.length ? Math.max(...deltas) : 0;
    return { kind: s.kind, from: s.startFrame, to: s.endFrame, expected: expected.length, started: deltas.length, missing, worst, html5, html5Srcs, suspended, buffers: starts.length };
  });
  for (const kind of ['first tap', 'resume', 'seek'] as const) {
    const rows = soundRows.filter((r) => r.kind === kind && r.expected > 0);
    if (rows.length === 0) {
      line(false, `sounds after ${kind === 'first tap' ? 'the first tap' : kind === 'resume' ? 'a pause and resume' : 'a seek'}`, 'not run yet');
      continue;
    }
    const ok = rows.every((r) => r.missing.length === 0 && r.worst <= SLACK);
    line(
      ok,
      `every cue starts within ${SLACK} frames on a running AudioContext after ${kind === 'first tap' ? 'the first tap' : kind === 'resume' ? 'a pause and resume' : 'a seek'}, through Web Audio`,
      rows
        .map((r) => `frames ${r.from}-${r.to}: ${r.started}/${r.expected} cues, worst ${r.worst.toFixed(1)} f, ${r.buffers} buffers${r.suspended ? `, ${r.suspended} on a suspended context` : ''}${r.html5 ? `, ${r.html5} via <audio>` : ''}${r.missing.length ? `; missing ${r.missing.slice(0, 8).join(', ')}` : ''}`)
        .join(' | '),
    );
  }

  // 5. Smoothness, over every played span.
  let advanced = 0;
  let jumps = 0;
  let jumped = 0;
  let gaps = 0;
  let pairs = 0;
  let elapsed = 0;
  const frameMs = 1000 / fps;
  for (const s of closed) {
    for (let i = 1; i < s.samples.length; i++) {
      const a = s.samples[i - 1]!;
      const b = s.samples[i]!;
      const step = b.frame - a.frame;
      if (step < 0) continue;
      pairs++;
      advanced += step;
      elapsed += b.t - a.t;
      if (step > 1) (jumps++, (jumped += step - 1));
      if (b.t - a.t > 2 * frameMs) gaps++;
    }
  }
  const jumpShare = advanced ? jumped / advanced : 0;
  const gapShare = pairs ? gaps / pairs : 0;
  const speed = elapsed ? advanced / fps / (elapsed / 1000) : 0;
  line(
    advanced > 0 && jumpShare <= 0.02 && gapShare <= 0.02,
    'smooth enough: at most 2% of frames skipped and 2% of animation frames late',
    `${jumps} jumps skipping ${jumped} of ${advanced} frames (${(jumpShare * 100).toFixed(1)}%), ${gaps} of ${pairs} animation-frame gaps over ${(2 * frameMs).toFixed(0)} ms (${(gapShare * 100).toFixed(1)}%), played at ${(speed * 100).toFixed(0)}% of real time`,
  );

  // 6. Review and font.
  const font = [...document.fonts].filter((f) => f.family.replace(/["']/g, '') === 'Arimo').map((f) => f.status);
  const fontOk = font.includes('loaded') && document.fonts.check('700 20px Arimo');
  line(review.seen, 'the game review draws after the last frame', review.seen ? `visible at frame ${review.visibleAt}; "${review.summary}"` : `not seen (review from frame ${timeline.gameReview?.outStart})`);
  line(fontOk, 'the shipped font (Arimo) is loaded', `faces: ${font.join(', ') || 'none'}`);

  const data = {
    when: new Date().toISOString(),
    env,
    layers: kinds,
    inline,
    holds,
    sounds: soundRows,
    contexts,
    smooth: { jumps, jumped, advanced, gaps, pairs, speed },
    review,
    fonts: font,
    spans: closed.map((s) => ({ kind: s.kind, from: s.startFrame, to: s.endFrame, samples: s.samples.length, ms: Math.round(s.t1! - s.t0) })),
    console: consoleLog,
    lines,
  };
  return { lines, data };
}

// ---- App ----

interface Loaded {
  props: EpisodeProps;
  timeline: Timeline;
  cues: SoundCue[];
  fps: number;
  width: number;
  height: number;
}

/** The editor's document for a project (as the editor store's docOf). */
const docOf = (project: Project): Doc => ({
  moments: project.moments,
  characters: project.context.characters,
  themeId: project.themeId,
  format: projectFormat(project),
  ...(project.evalBar ? { evalBar: project.evalBar } : {}),
  ...(project.evalBarScale ? { evalBarScale: project.evalBarScale } : {}),
  ...(project.subtitles ? { subtitles: project.subtitles } : {}),
  ...(project.gameReview ? { gameReview: project.gameReview } : {}),
});

async function load(): Promise<Loaded> {
  const project = (await (await fetch('media/project.json')).json()) as Project;
  const sounds = (await (await fetch('sounds/bank.json')).json().catch(() => ({}))) as SoundBank;
  const { width, height, fps, durationSec } = project.source;
  const theme = getTheme(PROJECT_THEME_ID);
  // As the editor does on open: onto the project look, then unlocked holds follow its timing.
  const doc = normalize(adoptProjectLook(docOf(project), { width, height }), theme);
  const props = episodeProps(
    { durationSec, moments: doc.moments, characters: doc.characters, evalBar: doc.evalBar, evalBarScale: doc.evalBarScale, subtitles: doc.subtitles, transcript: project.transcript, gameReview: doc.gameReview },
    { src: 'media/source.mp4', theme, fileUrl: (file) => `media/${file}`, sounds },
  );
  const timeline = buildTimeline(doc.moments, fps, durationSec, gameReviewSec(theme));
  const cues = soundCues({ timeline, moments: doc.moments, characters: doc.characters, timing: theme.timing, sounds });
  return { props, timeline, cues, fps, width, height };
}

function environment(): Record<string, unknown> {
  const v = document.createElement('video');
  return {
    userAgent: navigator.userAgent,
    devicePixelRatio: window.devicePixelRatio,
    viewport: `${window.innerWidth}x${window.innerHeight}`,
    VideoDecoder: typeof (window as { VideoDecoder?: unknown }).VideoDecoder,
    AudioDecoder: typeof (window as { AudioDecoder?: unknown }).AudioDecoder,
    AudioContext: typeof window.AudioContext,
    canPlayAvcHigh: v.canPlayType('video/mp4; codecs="avc1.64001F"'),
    origin: location.origin,
  };
}

function App({ loaded }: { loaded: Loaded }) {
  const { props, timeline, cues, fps, width, height } = loaded;
  const player = useRef<PlayerRef>(null);
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState('Preparing reference frames…');
  const [playing, setPlaying] = useState(false);
  const [report, setReport] = useState<Report>();
  const [copied, setCopied] = useState('');
  const env = useMemo(environment, []);
  const reportUrl = __REPORT_URL__;

  const refresh = () => {
    const r = buildReport(env, timeline, cues, fps);
    setReport(r);
    console.log(JSON.stringify(r.data));
    if (reportUrl) fetch(reportUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(r.data) }).catch(() => undefined);
  };

  useEffect(() => {
    const decoder = (window as { VideoDecoder?: { isConfigSupported: (c: { codec: string }) => Promise<{ supported?: boolean }> } }).VideoDecoder;
    decoder?.isConfigSupported({ codec: 'avc1.64001F' }).then((r) => ((env as Record<string, unknown>).decoderConfig = r.supported), () => undefined);
  }, [env]);

  // Wire the measurements to the Player.
  useEffect(() => {
    const p = player.current;
    if (!p) return;
    live.fps = fps;
    live.frame = () => player.current?.getCurrentFrame();
    (window as { __alsPlayer?: PlayerRef }).__alsPlayer = p;

    let raf = 0;
    const tick = () => {
      const span = spans.at(-1);
      if (span && span.endFrame === undefined) {
        const frame = p.getCurrentFrame();
        const sample: Sample = { t: performance.now(), frame };
        const hold = holdRefs.find((h) => frame >= h.outStart + 1 && frame <= h.outStart + h.frames - 2);
        if (hold) {
          const px = pixels();
          if (px) {
            sample.hash = hashOf(px);
            sample.mean = meanOf(px);
            if (hold.ref) sample.diff = diffOf(px, hold.ref);
          }
        }
        const rv = timeline.gameReview;
        if (rv && !review.seen && frame >= rv.outStart + Math.round(fps / 2)) {
          const el = document.querySelector<HTMLElement>('.__remotion-player [data-testid=game-review]');
          const visible = !!el && (el.checkVisibility ? el.checkVisibility() : el.offsetParent !== null) && el.getBoundingClientRect().width > 0;
          if (visible) Object.assign(review, { seen: true, visibleAt: frame, summary: el.querySelector('[data-testid=game-review-summary]')?.textContent ?? '' });
        }
        const rect = document.querySelector('.__remotion-player')?.getBoundingClientRect();
        if (rect && rect.right > window.innerWidth + 1) inline.overflowed = true;
        for (const v of document.querySelectorAll('video')) if ((v as HTMLVideoElement & { webkitDisplayingFullscreen?: boolean }).webkitDisplayingFullscreen) inline.videoFullscreen = true;
        span.samples.push(sample);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    const onPlay = () => {
      spans.push({ kind: forceKind ?? nextKind, t0: pendingT0 ?? performance.now(), startFrame: p.getCurrentFrame(), samples: [] });
      pendingT0 = undefined;
      forceKind = undefined;
      setPlaying(true);
    };
    const close = (why: 'pause' | 'ended') => {
      const span = spans.at(-1);
      if (span && span.endFrame === undefined) {
        span.endFrame = p.getCurrentFrame();
        span.t1 = performance.now();
      }
      nextKind = why === 'pause' ? 'resume' : 'seek';
      setPlaying(false);
      setTimeout(refresh, 600);
    };
    const onPause = () => close('pause');
    const onEnded = () => close('ended');
    const onError = (e: { detail: { error: Error } }) => consoleLog.push(`player error: ${e.detail.error.message}`);
    p.addEventListener('play', onPlay);
    p.addEventListener('pause', onPause);
    p.addEventListener('ended', onEnded);
    p.addEventListener('error', onError);
    const onFull = () => inline.fullscreenEvents++;
    document.addEventListener('webkitbeginfullscreen', onFull, true);
    document.addEventListener('fullscreenchange', onFull, true);
    document.addEventListener('webkitfullscreenchange', onFull, true);
    const statusTimer = setInterval(() => setStatus((s) => (s.startsWith('Preparing') ? s : `frame ${p.getCurrentFrame()} / ${timeline.outFrames}`)), 250);
    return () => {
      cancelAnimationFrame(raf);
      clearInterval(statusTimer);
      p.removeEventListener('play', onPlay);
      p.removeEventListener('pause', onPause);
      p.removeEventListener('ended', onEnded);
      p.removeEventListener('error', onError);
      document.removeEventListener('webkitbeginfullscreen', onFull, true);
      document.removeEventListener('fullscreenchange', onFull, true);
      document.removeEventListener('webkitfullscreenchange', onFull, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- wired once
  }, []);

  // Reference frames, before any play: each hold's source frame as the next segment draws it.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const p = player.current;
      if (!p) return;
      await sleep(800);
      holdRefs.length = 0;
      for (const h of timeline.holds) {
        const ref: HoldRef = { momentId: h.momentId, outStart: h.outStart, frames: h.frames, sourceFrame: h.sourceFrame };
        // The first output frame after the hold that maps to the same source frame (a play frame of the next segment).
        let refFrame = h.outStart + h.frames;
        while (refFrame < timeline.outFrames && (timeMapFrame(timeline, refFrame).hold || timeMapFrame(timeline, refFrame).sourceFrame !== h.sourceFrame)) refFrame++;
        if (refFrame >= timeline.outFrames) refFrame = h.outStart + h.frames;
        ref.refFrame = refFrame;
        ref.ref = await seekAndGrab(p, refFrame);
        const inside = await seekAndGrab(p, h.outStart + 2);
        const before = await seekAndGrab(p, h.outStart - 1);
        if (ref.ref && inside) ref.pausedDiff = diffOf(ref.ref, inside);
        if (ref.ref && before) ref.controlDiff = diffOf(ref.ref, before);
        holdRefs.push(ref);
        if (cancelled) return;
      }
      p.seekTo(0);
      await sleep(300);
      if (cancelled) return;
      setReady(true);
      setStatus('Ready');
    })().catch((e: unknown) => setStatus(`prepare failed: ${String(e)}`));
    return () => {
      cancelled = true;
    };
  }, [timeline]);

  const play = (e: SyntheticEvent) => {
    pendingT0 = performance.now();
    player.current?.play(e);
  };
  const seekThenPlay = (e: SyntheticEvent, frame: number) => {
    const p = player.current;
    if (!p) return;
    if (p.isPlaying()) p.pause();
    forceKind = 'seek';
    p.seekTo(frame);
    pendingT0 = performance.now();
    p.play(e);
  };
  const copy = async () => {
    const text = `${report?.lines.join('\n') ?? ''}\n\n${JSON.stringify(report?.data)}`;
    try {
      await navigator.clipboard.writeText(text);
      setCopied('Copied');
    } catch {
      const area = document.createElement('textarea');
      area.value = text;
      document.body.append(area);
      area.select();
      setCopied(document.execCommand('copy') ? 'Copied' : 'Copy failed: select the text below');
      area.remove();
    }
  };
  const second = timeline.holds[1] ?? timeline.holds[0];

  return (
    <div>
      <Player
        ref={player}
        component={Episode}
        inputProps={props}
        durationInFrames={timeline.outFrames}
        fps={fps}
        compositionWidth={width}
        compositionHeight={height}
        controls={false}
        clickToPlay={false}
        doubleClickToFullscreen={false}
        spaceKeyToPlayOrPause={false}
        moveToBeginningWhenEnded={false}
        acknowledgeRemotionLicense
        style={{ width: '100%', aspectRatio: `${width} / ${height}` }}
      />
      <div style={{ padding: 12, display: 'grid', gap: 10 }}>
        <div data-testid="status">{status}</div>
        {!playing ? (
          <button className="big" data-testid="play" disabled={!ready} onClick={play}>
            {ready ? 'Tap to play' : 'Preparing…'}
          </button>
        ) : (
          <button className="big" data-testid="pause" style={{ background: '#8a5a00' }} onClick={() => player.current?.pause()}>
            Pause
          </button>
        )}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button data-testid="restart" disabled={!ready} onClick={(e) => seekThenPlay(e, 0)}>
            Restart
          </button>
          {second && (
            <button data-testid="jump" disabled={!ready} onClick={(e) => seekThenPlay(e, Math.max(0, second.outStart - 2 * fps))}>
              Jump to move {timeline.holds.indexOf(second) + 1}
            </button>
          )}
          <button data-testid="copy" disabled={!report} onClick={copy}>
            Copy report
          </button>
          <button data-testid="refresh" onClick={refresh}>
            Update report
          </button>
        </div>
        {copied && <div>{copied}</div>}
        {reportUrl && <div style={{ opacity: 0.6 }}>Reports also go to {reportUrl}</div>}
        <pre data-testid="report">{report ? report.lines.join('\n') : 'Play the episode through once, then pause/resume and restart.'}</pre>
      </div>
    </div>
  );
}

load().then(
  (loaded) =>
    createRoot(document.getElementById('root')!).render(
      // No StrictMode: its doubled effects would run two reference passes at once.
      <App loaded={loaded} />,
    ),
  (e: unknown) => (document.getElementById('root')!.textContent = `load failed: ${String(e)}`),
);
