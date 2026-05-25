// Resolves the base URL of the local Electron API server.
// Populated on app boot via initApiBase(); apiUrl() returns absolute URLs
// like "http://127.0.0.1:<port>/api/openai/chat".

let baseUrl: string = '';
let initPromise: Promise<string> | null = null;

export async function initApiBase(): Promise<string> {
  if (baseUrl) return baseUrl;
  if (initPromise) return initPromise;
  initPromise = (async () => {
    if (window.aios?.getApiPort) {
      try {
        const port = await window.aios.getApiPort();
        if (port) {
          baseUrl = `http://127.0.0.1:${port}`;
          return baseUrl;
        }
      } catch (e) {
        console.error('Failed to resolve API port:', e);
      }
    }
    // Web fallback (no Electron) — same-origin /api/... routes.
    baseUrl = '';
    return baseUrl;
  })();
  return initPromise;
}

export function apiUrl(path: string): string {
  return baseUrl + path;
}

export function getApiBase(): string {
  return baseUrl;
}
