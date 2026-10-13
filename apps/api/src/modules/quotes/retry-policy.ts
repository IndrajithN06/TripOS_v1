import { WaErrorKind } from '../../providers/whatsapp/meta-errors';

/**
 * Automatic delivery-retry policy for quotation items (text, PDF, photos).
 *
 * - Bounded: every item gets at most AUTO_RETRY_MAX_ATTEMPTS delivery attempts in total
 *   (1 initial send + 3 automatic retries). Staff can still press "Retry failed items" at any time.
 * - Only failures that can succeed later are retried automatically. Credential, account, window, template,
 *   recipient and policy problems cannot be fixed by waiting, so they are never retried automatically.
 * - Backoff doubles: after attempt 1 wait 1 min, after attempt 2 wait 2 min, after attempt 3 wait 4 min.
 */
export const AUTO_RETRY_MAX_ATTEMPTS = 4;
export const AUTO_RETRY_BASE_DELAY_MS = 60_000;

/** Failure kinds that no amount of waiting will fix. */
const NON_RETRYABLE_KINDS: ReadonlySet<WaErrorKind> = new Set(['auth', 'account', 'window_closed', 'template', 'recipient', 'policy']);

export interface SendOutcome { attemptId: string; ok: boolean; retryable: boolean }

/** Retryable only if the provider says it may succeed later AND the kind is not one that needs human action. */
export function isRetryableFailure(providerSaysRetryable: boolean, kind: WaErrorKind | undefined): boolean {
  return providerSaysRetryable && !(kind && NON_RETRYABLE_KINDS.has(kind));
}

/** Delay before the next automatic retry, given how many delivery attempts the item has already had. */
export function autoRetryDelayMs(attemptsSoFar: number): number {
  return AUTO_RETRY_BASE_DELAY_MS * 2 ** Math.max(0, attemptsSoFar - 1);
}

/** True while an item may still receive automatic retries. */
export const withinAutoRetryBudget = (attemptsSoFar: number) => attemptsSoFar < AUTO_RETRY_MAX_ATTEMPTS;
