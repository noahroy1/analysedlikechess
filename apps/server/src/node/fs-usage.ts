import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { CallTotalSchema, EDITOR_CALLS, UsageEntrySchema, type EditorCall, type ProjectUsage, type UsageEntry } from '@als/schema';
import type { UsageLog } from '../ports.ts';

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

/**
 * Spend as files: every paid call appends a line to `<projects>/.usage/usage.jsonl`
 * (the month-to-date total), and the editor's own calls also keep the running
 * totals they always had beside each project (`analysis/<call>-usage.json`).
 */
export class FsUsageLog implements UsageLog {
  private readonly projectsDir: string;
  private readonly logFile: string;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(projectsDir: string) {
    this.projectsDir = projectsDir;
    // A dot-folder: the project list only reads folders named like project ids.
    this.logFile = join(projectsDir, '.usage', 'usage.jsonl');
  }

  record(input: Omit<UsageEntry, 'at'> & { at?: string }): Promise<void> {
    const entry = UsageEntrySchema.parse({ ...input, costUsd: round6(input.costUsd), at: input.at ?? new Date().toISOString() });
    const next = this.chain.catch(() => undefined).then(async () => {
      await mkdir(join(this.projectsDir, '.usage'), { recursive: true });
      await appendFile(this.logFile, `${JSON.stringify(entry)}\n`);
      if ((EDITOR_CALLS as readonly string[]).includes(entry.call)) {
        const call = entry.call as EditorCall;
        const total = await this.total(entry.projectId, call);
        const file = this.totalFile(entry.projectId, call);
        await mkdir(join(this.projectsDir, entry.projectId, 'analysis'), { recursive: true });
        await writeFile(`${file}.tmp`, JSON.stringify({ count: total.count + 1, costUsd: round6(total.costUsd + entry.costUsd) }));
        await rename(`${file}.tmp`, file);
      }
    });
    this.chain = next;
    return next;
  }

  async monthToDate(userId: string, now = new Date()): Promise<number> {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
    const text = await readFile(this.logFile, 'utf8').catch(() => '');
    let sum = 0;
    for (const line of text.split('\n')) {
      if (!line) continue;
      const entry = UsageEntrySchema.safeParse(JSON.parse(line));
      if (entry.success && entry.data.userId === userId && entry.data.at >= start) sum += entry.data.costUsd;
    }
    return round6(sum);
  }

  async projectTotals(projectId: string): Promise<ProjectUsage> {
    const [regenerate, evaluate, regions] = await Promise.all(EDITOR_CALLS.map((call) => this.total(projectId, call)));
    return { regenerate: regenerate!, evaluate: evaluate!, regions: regions! };
  }

  private totalFile(projectId: string, call: EditorCall) {
    return join(this.projectsDir, projectId, 'analysis', `${call}-usage.json`);
  }

  private total(projectId: string, call: EditorCall): Promise<z.infer<typeof CallTotalSchema>> {
    return readFile(this.totalFile(projectId, call), 'utf8')
      .then((t) => CallTotalSchema.parse(JSON.parse(t)))
      .catch(() => ({ count: 0, costUsd: 0 }));
  }
}
