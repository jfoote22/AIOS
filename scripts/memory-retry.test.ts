// H03 — enrichment retry policy. Covers the failure that stranded 15 already
// delivered notes: a transient Gemini 503/429 was written as a permanent error
// with memoryPending cleared, so no later pass ever reconsidered it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_MEMORY_RETRIES,
  isRetryDue,
  isRetryableEnrichError,
  nextRetryState,
  retryBackoffMs,
} from '../src/lib/memoryRetry.ts';

// The exact shapes seen in the field, taken from the stranded notes' stored
// `error` strings, plus the structured forms the SDK can throw.
const RETRYABLE: unknown[] = [
  { error: { code: 503, message: 'This model is currently experiencing high demand.' } },
  { error: { code: 429, message: 'You exceeded your current quota, please check your plan.' } },
  { status: 500 },
  { status: 502 },
  { status: 504 },
  { code: 429 },
  new Error('{"error":{"code":503,"message":"This model is currently experiencing high demand"}}'),
  new Error('429 Too Many Requests'),
  new Error('rate limit exceeded'),
  new Error('fetch failed'),
  new Error('ECONNRESET'),
  new Error('getaddrinfo ENOTFOUND generativelanguage.googleapis.com'),
  new Error('socket hang up'),
  new Error('The operation timed out'),
  new Error('Service Unavailable'),
];

const PERMANENT: unknown[] = [
  { status: 400 },
  { status: 401 },
  { status: 403 },
  { status: 404 },
  new Error('API key not valid. Please pass a valid API key.'),
  new Error('Request payload size exceeds the limit'),
  new Error('Unsupported MIME type'),
  new Error('TypeError: cannot read properties of undefined'),
];

test('transient provider failures are classified retryable', () => {
  for (const e of RETRYABLE) {
    assert.equal(isRetryableEnrichError(e), true, `should retry: ${JSON.stringify(e) || e}`);
  }
});

test('permanent failures are not retried', () => {
  for (const e of PERMANENT) {
    assert.equal(isRetryableEnrichError(e), false, `should NOT retry: ${JSON.stringify(e) || e}`);
  }
});

test('backoff grows exponentially and caps at 16 minutes', () => {
  assert.equal(retryBackoffMs(1), 30_000);
  assert.equal(retryBackoffMs(2), 60_000);
  assert.equal(retryBackoffMs(3), 120_000);
  assert.equal(retryBackoffMs(4), 240_000);
  assert.equal(retryBackoffMs(5), 480_000);
  assert.equal(retryBackoffMs(6), 960_000);
  // Capped, never unbounded.
  for (const n of [7, 8, 20, 500]) assert.equal(retryBackoffMs(n), 960_000);
  // Strictly increasing up to the cap — a flat curve would hammer the provider.
  for (let n = 2; n <= 6; n++) assert.ok(retryBackoffMs(n) > retryBackoffMs(n - 1));
});

test('a retryable failure stays pending, keeps its id, and schedules a future attempt', () => {
  const now = 1_000_000;
  const next = nextRetryState(0, { error: { code: 503, message: 'high demand' } }, now);
  assert.equal(next.status, 'analyzing');
  assert.equal(next.memoryPending, true, 'must stay pending or no sweep revisits it');
  assert.equal(next.memoryRetryCount, 1);
  assert.equal(next.memoryRetryAt, now + 30_000);
  assert.equal(next.error, undefined, 'a note being retried should not display an error');
});

test('attempts are capped — the budget is spent, then the note is parked', () => {
  const transient = { error: { code: 503, message: 'high demand' } };
  // Every attempt within budget keeps it pending.
  for (let prior = 0; prior < MAX_MEMORY_RETRIES; prior++) {
    const next = nextRetryState(prior, transient, 0);
    assert.equal(next.memoryPending, true, `attempt ${prior + 1} should still retry`);
    assert.equal(next.memoryRetryCount, prior + 1);
  }
  // One past the budget parks it, with the message preserved for the user.
  const exhausted = nextRetryState(MAX_MEMORY_RETRIES, transient, 0);
  assert.equal(exhausted.status, 'error');
  assert.equal(exhausted.memoryPending, false, 'must stop, or the loop never drains');
  assert.equal(exhausted.memoryRetryAt, undefined);
  assert.ok(exhausted.error, 'a parked note must say why');
});

test('a permanent failure parks immediately without burning the retry budget', () => {
  const next = nextRetryState(0, new Error('API key not valid'), 0);
  assert.equal(next.status, 'error');
  assert.equal(next.memoryPending, false);
  assert.equal(next.memoryRetryAt, undefined);
  assert.match(String(next.error), /API key not valid/);
});

test('items inside their backoff window are skipped, not dropped', () => {
  const now = 1_000_000;
  assert.equal(isRetryDue(now + 1, now), false, 'future retry is not due yet');
  assert.equal(isRetryDue(now - 1, now), true, 'past retry is due');
  assert.equal(isRetryDue(now, now), true, 'exactly due counts as due');
  // A note that has never failed carries no schedule and is always due.
  assert.equal(isRetryDue(undefined, now), true);
});

test('the drain loop terminates: a fast-failing note leaves the due set', () => {
  // Reproduces the spin risk — repeated immediate failures must not stay due.
  const now = 5_000;
  let attempts: number | undefined = undefined;
  for (let i = 0; i < 3; i++) {
    const next = nextRetryState(attempts, { status: 503 }, now);
    attempts = next.memoryRetryCount;
    assert.equal(isRetryDue(next.memoryRetryAt, now), false, 'must not be immediately re-due');
  }
});
