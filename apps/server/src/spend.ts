import { DEFAULT_MONTHLY_CAP_USD } from '@als/schema';
import { OverCapError, type UsageLog } from './ports.ts';

/**
 * Per-user monthly spend caps, checked before every paid call. The cap comes
 * from one place (DEFAULT_MONTHLY_CAP_USD; per-user caps arrive with profiles in C3).
 */
export class Spend {
  readonly usage: UsageLog;
  private readonly capUsd: number;

  constructor(usage: UsageLog, capUsd = DEFAULT_MONTHLY_CAP_USD) {
    this.usage = usage;
    this.capUsd = capUsd;
  }

  capFor(_userId: string): number {
    return this.capUsd;
  }

  async status(userId: string): Promise<{ monthToDateUsd: number; monthlyCapUsd: number }> {
    return { monthToDateUsd: await this.usage.monthToDate(userId), monthlyCapUsd: this.capFor(userId) };
  }

  /** Throws OverCapError once this month's spend has reached the cap. */
  async check(userId: string): Promise<void> {
    const { monthToDateUsd, monthlyCapUsd } = await this.status(userId);
    if (monthToDateUsd >= monthlyCapUsd) {
      throw new OverCapError(`This month's AI spend ($${monthToDateUsd.toFixed(2)}) has reached the $${monthlyCapUsd.toFixed(2)} cap.`);
    }
  }
}
