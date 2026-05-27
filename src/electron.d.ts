export {};

declare global {
  interface Window {
    aios?: {
      isElectron: true;
      requestCapture: () => void;
      requestCaptureForItem: (itemId: string) => void;
      onSnipImage: (cb: (payload: { dataUrl: string; targetId: string | null }) => void) => () => void;
      getVersion: () => Promise<string>;
      getApiPort: () => Promise<number>;
      pickFolder: (opts?: { title?: string; defaultPath?: string }) => Promise<string | null>;
      getProviderKey: (providerId: string) => Promise<string>;
      setProviderKey: (providerId: string, key: string) => Promise<true>;
      clearProviderKey: (providerId: string) => Promise<true>;
      listProviders: () => Promise<string[]>;
      isSecureStorageAvailable: () => Promise<boolean>;
      getModels: () => Promise<Record<string, string>>;
      setModel: (slot: string, modelId: string) => Promise<Record<string, string>>;
      resetModel: (slot: string) => Promise<Record<string, string>>;
      getModelDefaults: () => Promise<Record<string, string>>;
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
        onData: (cb: (p: { id: string; data: string }) => void) => () => void;
        onExit: (cb: (p: { id: string; exitCode: number; signal?: number }) => void) => () => void;
      };
    };
  }
}
