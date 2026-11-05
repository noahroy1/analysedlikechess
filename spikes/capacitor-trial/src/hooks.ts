// Installed before the Player mounts (imported first by main.tsx): logs every sound the page starts,
// with the Player frame it lands on, as scripts/browser/sound-checks.mjs does, plus console warnings.

export interface SoundStart {
  t: number;
  frame: number;
  /** Set when the sound went through an <audio>/<video> element instead of Web Audio. */
  html5?: string;
  length?: number;
  contextState?: string;
}

interface Live {
  frame: () => number | undefined;
  fps: number;
}

export const live: Live = { frame: () => undefined, fps: 30 };
export const soundLog: SoundStart[] = [];
export const consoleLog: string[] = [];
export const contexts: { t: number; state: string; sampleRate: number }[] = [];

const start = AudioBufferSourceNode.prototype.start;
AudioBufferSourceNode.prototype.start = function (this: AudioBufferSourceNode, when = 0, ...rest: number[]) {
  const frame = live.frame();
  // Logged even before the Player reports playing: frame 0's sounds are scheduled while the context resumes.
  if (frame !== undefined) {
    const ahead = Math.max(0, when - this.context.currentTime);
    soundLog.push({ t: performance.now(), frame: frame + ahead * live.fps, length: this.buffer?.duration ?? 0, contextState: this.context.state });
  }
  return start.call(this, when, ...rest);
} as typeof start;

const play = HTMLMediaElement.prototype.play;
HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
  const frame = live.frame();
  if (this.tagName === 'AUDIO' && frame !== undefined) soundLog.push({ t: performance.now(), frame, html5: this.currentSrc || this.src });
  return play.call(this);
};

const Ctx = window.AudioContext;
if (Ctx) {
  window.AudioContext = class extends Ctx {
    constructor(options?: AudioContextOptions) {
      super(options);
      contexts.push({ t: performance.now(), state: this.state, sampleRate: this.sampleRate });
      this.addEventListener('statechange', () => contexts.push({ t: performance.now(), state: this.state, sampleRate: this.sampleRate }));
    }
  };
}

for (const level of ['warn', 'error'] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    if (consoleLog.length < 40) consoleLog.push(`${level}: ${args.map((a) => (a instanceof Error ? a.message : typeof a === 'string' ? a : JSON.stringify(a))).join(' ').slice(0, 300)}`);
    original(...args);
  };
}
window.addEventListener('error', (e) => consoleLog.length < 40 && consoleLog.push(`uncaught: ${e.message}`));
window.addEventListener('unhandledrejection', (e) => consoleLog.length < 40 && consoleLog.push(`rejection: ${String(e.reason)}`));
