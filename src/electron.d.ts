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
      getProviderKey: (providerId: string) => Promise<string>;
      setProviderKey: (providerId: string, key: string) => Promise<true>;
      clearProviderKey: (providerId: string) => Promise<true>;
      listProviders: () => Promise<string[]>;
      isSecureStorageAvailable: () => Promise<boolean>;
    };
  }
}
