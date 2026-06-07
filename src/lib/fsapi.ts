// Client wrappers for the sandboxed IDE file ops (electron/api-server.cjs
// /api/fs/*). Every call is scoped to a `root` folder that must live under a
// `.claude` directory — the server enforces that the target never escapes it.
// Used by the "Editor" mode of the Agent/Skill creators.

import { apiUrl } from './apiBase';

export interface FsNode {
  name: string;
  path: string;            // path relative to root, using "/" separators
  type: 'file' | 'dir';
  children?: FsNode[];
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(apiUrl(path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(err.error || `Request failed (${res.status})`);
  }
  return res.json();
}

export function fsTree(root: string): Promise<{ root: string; tree: FsNode[]; truncated: boolean }> {
  return post('/api/fs/tree', { root });
}

export function fsRead(root: string, relPath: string): Promise<{ content: string }> {
  return post('/api/fs/read', { root, relPath });
}

export function fsWrite(root: string, relPath: string, content: string): Promise<{ ok: true; path: string }> {
  return post('/api/fs/write', { root, relPath, content });
}

export function fsCreate(root: string, relPath: string, kind: 'file' | 'dir'): Promise<{ ok: true; path: string }> {
  return post('/api/fs/create', { root, relPath, kind });
}

export function fsDelete(root: string, relPath: string): Promise<{ ok: true }> {
  return post('/api/fs/delete', { root, relPath });
}

export function fsRename(root: string, relPath: string, newRelPath: string): Promise<{ ok: true; path: string }> {
  return post('/api/fs/rename', { root, relPath, newRelPath });
}
