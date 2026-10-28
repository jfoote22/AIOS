// Renderer side of model routing (electron/model-router.cjs): which model each
// AI task uses, the connections that are set up, and a generic `aiGenerate`
// call. Settings → Models edits this; features call aiGenerate with a task.

import { apiUrl } from './apiBase';

// Keep in sync with TASKS in electron/model-routing.cjs.
export type AiTask = 'vault-ask' | 'ocr' | 'tagging' | 'understanding' | 'research' | 'drafting'
  | 'coding' | 'general' | 'planning';

export interface ModelOption { id: string; label: string }

export interface Connection {
  id: string;
  label: string;
  kind: string;
  auth: 'api' | 'subscription' | 'url';
  available: boolean;
  reason: string;
  vision: boolean;
  models: ModelOption[];
  custom?: boolean;
  baseUrl?: string;
  hasKey?: boolean;
}

export interface RoutingView {
  default: string;
  tasks: Partial<Record<AiTask, string>>;
  /** 'local' | 'gemini' | "<connection>:<model>" */
  embeddings: string;
  fallback: boolean;
  taskList: { id: AiTask; label: string }[];
  connections: Connection[];
  ready: Record<AiTask, boolean>;
}

let view: RoutingView | null = null;
const listeners = new Set<(v: RoutingView) => void>();

function publish(next: RoutingView): RoutingView {
  view = next;
  for (const fn of listeners) fn(next);
  return next;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(apiUrl(path), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data as T;
}

export function getRouting(): RoutingView | null { return view; }

export function onRoutingChange(fn: (v: RoutingView) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export async function refreshRouting(): Promise<RoutingView | null> {
  try { return publish(await request<RoutingView>('/api/models/routing')); }
  catch (e) { console.error('Failed to load model routing:', e); return view; }
}

export async function saveRouting(patch: Partial<Pick<RoutingView, 'default' | 'tasks' | 'embeddings' | 'fallback'>>): Promise<RoutingView> {
  return publish(await request<RoutingView>('/api/models/routing', { method: 'PUT', body: JSON.stringify(patch) }));
}

export interface ConnectionInput {
  id: string;
  label: string;
  baseUrl: string;
  models: string[];
  vision: boolean;
  /** undefined keeps the stored key; '' removes it. */
  apiKey?: string;
}

export async function saveConnection(input: ConnectionInput): Promise<RoutingView> {
  return publish(await request<RoutingView>('/api/models/connections', { method: 'POST', body: JSON.stringify(input) }));
}

export async function removeConnection(id: string): Promise<RoutingView> {
  return publish(await request<RoutingView>(`/api/models/connections/${encodeURIComponent(id)}`, { method: 'DELETE' }));
}

export async function detectModels(input: { baseUrl: string; apiKey?: string; id?: string }): Promise<string[]> {
  return (await request<{ models: string[] }>('/api/models/detect', { method: 'POST', body: JSON.stringify(input) })).models;
}

export async function testModel(ref: string): Promise<string> {
  return (await request<{ reply: string }>('/api/models/test', { method: 'POST', body: JSON.stringify({ ref }) })).reply;
}

/** A text model is connected for everyday tasks (tagging, topic maps, ...). */
export function isTextModelReady(): boolean {
  return !!view?.ready?.tagging;
}

/** Embeddings can run: the built-in model always can; others need their connection. */
export function embeddingsMode(): string {
  return view?.embeddings || 'local';
}

/**
 * Run one task on its routed model. Returns the full reply and the model's
 * display name. With `json`, the model is told to reply with JSON only (parse
 * it with parseJsonObject).
 */
export async function aiGenerate(input: {
  task: AiTask;
  prompt: string;
  system?: string;
  imageDataUrl?: string;
  json?: boolean;
}): Promise<{ text: string; label: string }> {
  return request<{ text: string; label: string }>('/api/ai/generate', { method: 'POST', body: JSON.stringify(input) });
}

/** First JSON object in a model reply (tolerates code fences or prose). */
export function parseJsonObject<T>(reply: string): T {
  const start = reply.indexOf('{');
  const end = reply.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('The model did not return JSON.');
  return JSON.parse(reply.slice(start, end + 1)) as T;
}
