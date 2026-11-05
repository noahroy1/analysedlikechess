import { describe, expect, it } from 'vitest';
import { containerCostUsd, isContainerType } from './prices.ts';

describe('container prices', () => {
  it('prices an instance by its size, as C0 costed BB1', () => {
    // standard-4: 4 vCPU, 12 GiB, 20 GB of disk. C0's BB1 render ran 346 s for about $0.039.
    expect(containerCostUsd('standard-4', 1)).toBeCloseTo(4 * 0.00002 + 12 * 0.0000025 + 20 * 0.00000007, 12);
    expect(containerCostUsd('standard-4', 346)).toBeCloseTo(0.0385, 4);
    expect(containerCostUsd('basic', 60)).toBeCloseTo(60 * (0.25 * 0.00002 + 1 * 0.0000025 + 4 * 0.00000007), 12);
    expect(containerCostUsd('lite', 0)).toBe(0);
  });

  it('knows the instance types and nothing else', () => {
    expect(isContainerType('standard-4')).toBe(true);
    expect(isContainerType('lite')).toBe(true);
    expect(isContainerType('standard-5')).toBe(false);
    expect(isContainerType('toString')).toBe(false);
  });
});
