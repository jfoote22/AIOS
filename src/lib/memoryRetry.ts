// Retry policy for Second Brain enrichment failures.
//
// Deliberately free of imports so it can be unit-tested directly under
// `node --experimental-strip-types` (same reason chatSession.ts is standalone).
// memory.ts owns the I/O; this module owns only the decision.
//
// Background: Gemini routinely answers 503 ("high demand") or 429 (quota) for a
// few seconds at a time. Treating those as permanent stranded 15 already
// delivered notes — they were written as status:'error' with memoryPending
// cleared, so no later pass ever reconsidered them.

/** Give up after this many RETRYABLE failures and park the note as an error. */
export const MAX_MEMORY_RETRIES = 6;

/** Backoff before attempt n (1-based): 30s, 1m, 2m, 4m, 8m, 16m — then capped. */
export function retryBackoffMs(attempt: number): number {
  return Math.min(30_000 * 2 ** (attempt - 1), 16 * 60_000);
}

/**
 * True for failures worth retrying: rate limits, server-side errors, and
 * transport faults. Anything else — a malformed request, a rejected key, an
 * oversized payload — would fail identically forever, so it is parked
 * immediately rather than looped.
 *
 * Gemini reports its status as `error.code` in the JSON body rather than on the
 * thrown object, and the SDK often surfaces the whole body as the message, so
 * check the structured fields and the text.
 */
export function isRetryableEnrichError(e: unknown): boolean {
  const status = Number(
    (e as any)?.status ?? (e as any)?.code ?? (e as any)?.error?.code,
  );
  if (Number.isFinite(status) && (status === 429 || (status >= 500 && status <= 599))) return true;
  const message = ((e as Error)?.message || String(e ?? '')).toLowerCase();
  if (/\b(429|500|502|503|504)\b/.test(message)) return true;
  return /rate.?limit|quota|high demand|overload|timeout|timed out|socket|network|econn|enotfound|eai_again|fetch failed|unavailable/
    .test(message);
}

/** The retry bookkeeping carried on a pending item, inside its JSON blob. */
export interface RetryFields {
  status: 'analyzing' | 'error';
  error: string | undefined;
  memoryPending: boolean;
  memoryRetryCount: number;
  memoryRetryAt: number | undefined;
}

/**
 * Decide what to write back after `enrichOne` throws. Retryable failures stay
 * 'analyzing' + pending behind a backoff, keeping the SAME item id so a retry
 * updates the row in place and never produces a duplicate neuron. Permanent
 * failures (or an exhausted budget) clear the pending flag and park the note
 * with its message, which is what stops the drain loop spinning.
 */
export function nextRetryState(
  previousAttempts: number | undefined,
  error: unknown,
  now: number = Date.now(),
): RetryFields {
  const attempt = (previousAttempts ?? 0) + 1;
  const retryable = isRetryableEnrichError(error) && attempt <= MAX_MEMORY_RETRIES;
  return {
    status: retryable ? 'analyzing' : 'error',
    error: retryable ? undefined : ((error as Error)?.message || String(error)),
    memoryPending: retryable,
    memoryRetryCount: attempt,
    memoryRetryAt: retryable ? now + retryBackoffMs(attempt) : undefined,
  };
}

/**
 * Whether a pending item is due. Items inside their backoff window are skipped
 * rather than dropped, which is what lets the drain loop terminate instead of
 * spinning on a note that is failing fast.
 */
export function isRetryDue(memoryRetryAt: number | undefined, now: number = Date.now()): boolean {
  return !(memoryRetryAt && memoryRetryAt > now);
}
