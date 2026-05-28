// Agent runs: one record per Play of an agent on a card.
// Storage is local IndexedDB. The actual stream/cancel happens via the
// Electron API server (/api/agents/run, /api/agents/run/cancel).

import * as db from './db';
import { apiUrl } from './apiBase';
import { getAnthropicAuthMode } from './authMode';
import type { AgentDef } from './agents';

export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';

export interface AgentRun {
  id: string;
  cardId: string;
  agentId: string;
  agentSlug: string;       // duplicated for display even if agent is later renamed
  status: RunStatus;
  startedAt: number;
  finishedAt?: number;
  transcript: string;       // accumulated text/tool output
  error?: string;
}

export interface StartRunArgs {
  card: { id: string; title: string; description?: string };
  agent: AgentDef;
}

export interface StartRunResult {
  run: AgentRun;
  stream: ReadableStream<Uint8Array>;
}

export function newRun(args: StartRunArgs): AgentRun {
  const now = Date.now();
  return {
    id: `run-${now}-${Math.random().toString(36).slice(2, 8)}`,
    cardId: args.card.id,
    agentId: args.agent.id,
    agentSlug: args.agent.slug,
    status: 'running',
    startedAt: now,
    transcript: '',
  };
}

/**
 * Kick off an agent run and return the server's stream so the caller can
 * consume deltas. The caller is responsible for persisting transcript and
 * status updates back to IndexedDB as the stream progresses.
 *
 * The endpoint emits the Vercel AI data-stream protocol used elsewhere:
 *   0:"text"\n      = text delta
 *   d:{...}\n       = finish_message
 *   3:"..."\n       = error
 */
export async function startRun(args: StartRunArgs): Promise<StartRunResult> {
  const authMode = await getAnthropicAuthMode();
  const run = newRun(args);
  await db.putRun(run);

  const res = await fetch(apiUrl('/api/agents/run'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      runId: run.id,
      authMode,
      card: args.card,
      agent: {
        id: args.agent.id,
        slug: args.agent.slug,
        name: args.agent.name,
        systemPrompt: args.agent.systemPrompt,
        model: args.agent.model,
        allowedTools: args.agent.allowedTools,
        workingDir: args.agent.workingDir,
      },
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    const failed: AgentRun = { ...run, status: 'failed', error: err.error || `HTTP ${res.status}`, finishedAt: Date.now() };
    await db.putRun(failed);
    throw new Error(err.error || `Run failed (${res.status})`);
  }
  if (!res.body) {
    const failed: AgentRun = { ...run, status: 'failed', error: 'No response body from run endpoint.', finishedAt: Date.now() };
    await db.putRun(failed);
    throw new Error('No response body from run endpoint.');
  }
  return { run, stream: res.body };
}

export async function cancelRun(runId: string): Promise<void> {
  await fetch(apiUrl('/api/agents/run/cancel'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ runId }),
  }).catch(() => {});
}

export async function recordRun(run: AgentRun): Promise<void> {
  await db.putRun(run);
}

export const listRuns = () => db.getAllRuns<AgentRun>();
export const listRunsForCard = (cardId: string) => db.getRunsForCard<AgentRun>(cardId);

/**
 * Consume the Vercel AI data-stream protocol (`0:"..."\n`, `d:{...}\n`,
 * `3:"..."\n`). Yields a series of typed events the caller can drive into UI.
 */
export type StreamEvent =
  | { type: 'text'; value: string }
  | { type: 'finish'; reason?: string }
  | { type: 'error'; value: string };

export async function* parseRunStream(stream: ReadableStream<Uint8Array>): AsyncGenerator<StreamEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        const colon = line.indexOf(':');
        if (colon < 0) continue;
        const code = line.slice(0, colon);
        const rest = line.slice(colon + 1);
        try {
          const parsed = JSON.parse(rest);
          if (code === '0' && typeof parsed === 'string') yield { type: 'text', value: parsed };
          else if (code === 'd') yield { type: 'finish', reason: parsed?.finishReason };
          else if (code === '3') yield { type: 'error', value: String(parsed) };
        } catch { /* ignore malformed lines */ }
      }
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }
}

