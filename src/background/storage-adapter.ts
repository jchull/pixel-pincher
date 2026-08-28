export interface StorageAdapter {
  get(keys: readonly string[]): Promise<Readonly<Record<string, unknown>>>;
  set(values: Readonly<Record<string, unknown>>): Promise<void>;
  remove(keys: readonly string[]): Promise<void>;
}

/** Adapter boundary for chrome.storage.local; tests inject StorageAdapter directly. */
export function createChromeStorageAdapter(): StorageAdapter {
  return {
    async get(keys) {
      return chrome.storage.local.get([...keys]);
    },
    async set(values) {
      await chrome.storage.local.set(values);
    },
    async remove(keys) {
      await chrome.storage.local.remove([...keys]);
    },
  };
}
