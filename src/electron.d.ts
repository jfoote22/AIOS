export {};

export interface MemoryIngestStatus {
  enabled: boolean;
  running: boolean;
  port: number;
  address: string;
  hasToken: boolean;
  token: string;
  error?: string;
}

export interface MobileGatewayStatus {
  enabled: boolean;
  running: boolean;
  port: number;
  address: string;
  hasToken: boolean;
  token: string;
  hasTerminal: boolean;
  error?: string;
}

declare global {
  interface Window {
    aios?: {
      isElectron: true;
      requestCapture: () => void;
      requestCaptureForItem: (itemId: string) => void;
      onSnipImage: (cb: (payload: { dataUrl: string; targetId: string | null }) => void) => () => void;
      /** Promise-based region capture: triggers the overlay and resolves with the
       *  cropped image (or null if cancelled). Lets the caller handle the result
       *  inline instead of via the global onSnipImage broadcast. */
      captureRegion: () => Promise<{ dataUrl: string } | null>;
      getVersion: () => Promise<string>;
      getApiPort: () => Promise<number>;
      pickFolder: (opts?: { title?: string; defaultPath?: string }) => Promise<string | null>;
      pickFiles: (opts?: { title?: string; filters?: { name: string; extensions: string[] }[] }) => Promise<string[]>;
      getProviderKey: (providerId: string) => Promise<string>;
      setProviderKey: (providerId: string, key: string) => Promise<true>;
      clearProviderKey: (providerId: string) => Promise<true>;
      listProviders: () => Promise<string[]>;
      isSecureStorageAvailable: () => Promise<boolean>;
      getModels: () => Promise<Record<string, string>>;
      setModel: (slot: string, modelId: string) => Promise<Record<string, string>>;
      resetModel: (slot: string) => Promise<Record<string, string>>;
      getModelDefaults: () => Promise<Record<string, string>>;
      db: {
        /** Invoke a whitelisted SQLite op by name with a positional args array. */
        call: <T = unknown>(op: string, args?: unknown[]) => Promise<T>;
      };
      /** LAN memory-ingest webhook config (feeds external markdown into Second Brain). */
      memory: {
        getConfig: () => Promise<MemoryIngestStatus>;
        setConfig: (cfg: { enabled?: boolean; port?: number }) => Promise<MemoryIngestStatus>;
        regenerateToken: () => Promise<MemoryIngestStatus>;
        onIngested: (cb: (payload: { id: string }) => void) => () => void;
      };
      /** LAN/remote gateway for the Android companion app. */
      mobile: {
        getConfig: () => Promise<MobileGatewayStatus>;
        setConfig: (cfg: { enabled?: boolean; port?: number }) => Promise<MobileGatewayStatus>;
        regenerateToken: () => Promise<MobileGatewayStatus>;
      };
      term: {
        available: () => Promise<{ available: boolean; platform: string }>;
        spawn: (opts?: {
          shell?: string;
          args?: string[];
          cwd?: string;
          cols?: number;
          rows?: number;
          env?: Record<string, string>;
        }) => Promise<{ id: string; shell: string; cwd: string }>;
        write: (id: string, data: string) => Promise<void>;
        resize: (id: string, cols: number, rows: number) => Promise<void>;
        kill: (id: string) => Promise<void>;
        /** Tear a session off into its own window. */
        openWindow: (payload: { id: string; label?: string }) => Promise<boolean>;
        /** From inside a popout window: take over a session's output stream.
         *  Returns the scrollback so far; live chunks with seq > lastSeq follow. */
        adopt: (id: string) => Promise<{ id: string; shell: string; cwd: string; buffer: string; lastSeq: number }>;
        onData: (cb: (p: { id: string; data: string; seq?: number }) => void) => () => void;
        onExit: (cb: (p: { id: string; exitCode: number; signal?: number }) => void) => () => void;
      };
    };
  }
}
