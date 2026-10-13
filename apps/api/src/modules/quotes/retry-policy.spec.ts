import { AUTO_RETRY_BASE_DELAY_MS, AUTO_RETRY_MAX_ATTEMPTS, autoRetryDelayMs, isRetryableFailure, withinAutoRetryBudget } from './retry-policy';

describe('quote delivery retry policy', () => {
  it('has a clear, small limit: 4 attempts per item (1 initial + 3 automatic retries)', () => {
    expect(AUTO_RETRY_MAX_ATTEMPTS).toBe(4);
    expect([0, 1, 2, 3].every(withinAutoRetryBudget)).toBe(true);
    expect([4, 5, 16].some(withinAutoRetryBudget)).toBe(false);
  });

  it('backs off 1, 2 then 4 minutes', () => {
    expect([1, 2, 3].map(autoRetryDelayMs)).toEqual([60_000, 120_000, 240_000]);
    expect(AUTO_RETRY_BASE_DELAY_MS).toBe(60_000);
    expect(autoRetryDelayMs(0)).toBe(60_000);
  });

  it.each(['auth', 'account', 'window_closed', 'template', 'recipient', 'policy'] as const)('%s failures are never retried automatically, even if the provider says retryable', (kind) => {
    expect(isRetryableFailure(true, kind)).toBe(false);
  });

  it.each(['rate_limit', 'transient', 'unknown', undefined] as const)('%s failures are retryable when the provider says so', (kind) => {
    expect(isRetryableFailure(true, kind)).toBe(true);
    expect(isRetryableFailure(false, kind)).toBe(false);
  });
});
