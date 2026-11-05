import { DEFAULT_MONTHLY_CAP_USD } from '@als/schema';
import { OverCapError, type Profile, type ProfileStore, type UsageLog } from './ports.ts';

/** The one local user of the Node server. */
const LOCAL_PROFILE: ProfileStore = { get: async () => ({ role: 'admin' }) };

/**
 * Per-user monthly spend caps, checked before every paid call. The default
 * cap lives in one place (DEFAULT_MONTHLY_CAP_USD); a profile may set its own.
 */
export class Spend {
  readonly usage: UsageLog;
  readonly profiles: ProfileStore;
  private readonly capUsd: number;

  constructor(usage: UsageLog, options: { profiles?: ProfileStore; capUsd?: number } = {}) {
    this.usage = usage;
    this.profiles = options.profiles ?? LOCAL_PROFILE;
    this.capUsd = options.capUsd ?? DEFAULT_MONTHLY_CAP_USD;
  }

  async status(userId: string): Promise<{ profile: Profile; monthToDateUsd: number; monthlyCapUsd: number }> {
    const [profile, monthToDateUsd] = await Promise.all([this.profiles.get(userId), this.usage.monthToDate(userId)]);
    return { profile, monthToDateUsd, monthlyCapUsd: profile.monthlyCapUsd ?? this.capUsd };
  }

  /** Throws OverCapError once this month's spend has reached the cap. */
  async check(userId: string): Promise<void> {
    const { monthToDateUsd, monthlyCapUsd } = await this.status(userId);
    if (monthToDateUsd >= monthlyCapUsd) {
      throw new OverCapError(`This month's AI spend ($${monthToDateUsd.toFixed(2)}) has reached the $${monthlyCapUsd.toFixed(2)} cap.`);
    }
  }
}
