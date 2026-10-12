import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export interface RunOptions {
  /** Called with each stdout line as it arrives. */
  onLine?: (line: string) => void;
}

export class CommandError extends Error {
  constructor(command: string, code: number | null, stderr: string) {
    const tail = stderr.trim().split('\n').slice(-6).join('\n');
    super(`${command} exited with ${code}${tail ? `:\n${tail}` : ''}`);
  }
}

/** Runs a command to completion and resolves with its stdout. */
export function run(command: string, args: string[], options: RunOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out: string[] = [];
    let stderr = '';
    createInterface({ input: child.stdout }).on('line', (line) => {
      out.push(line);
      options.onLine?.(line);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      // Keep only the tail; ffmpeg can be chatty on long files.
      stderr = (stderr + chunk.toString()).slice(-8000);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(out.join('\n'));
      else reject(new CommandError(command, code, stderr));
    });
  });
}

/**
 * Runs ffmpeg with machine-readable progress on stdout, reporting 0-1 against
 * the expected output duration.
 */
export function ffmpeg(args: string[], durationSec: number, onProgress?: (p: number) => void): Promise<string> {
  return run('ffmpeg', ['-hide_banner', '-nostats', '-loglevel', 'error', '-y', '-progress', 'pipe:1', ...args], {
    onLine: (line) => {
      const match = /^out_time_us=(\d+)$/.exec(line);
      if (match && onProgress && durationSec > 0) {
        onProgress(Math.min(1, Number(match[1]) / 1e6 / durationSec));
      }
    },
  });
}
