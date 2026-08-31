export interface StorageAdapter {
  get(keys: readonly string[]): Promise<Readonly<Record<string, unknown>>>;
  /** Reserved for one-time index migration and explicit corruption-recovery purge. */
  readAll(): Promise<Readonly<Record<string, unknown>>>;
  set(values: Readonly<Record<string, unknown>>): Promise<void>;
  remove(keys: readonly string[]): Promise<void>;
}

export class StorageAdapterError extends Error {
  constructor(operation: "get" | "read-all" | "set" | "remove", cause: unknown) {
    super(`Chrome storage ${operation} failed.`, { cause });
    this.name = "StorageAdapterError";
  }
}

async function wrapStorageOperation<T>(
  operation: "get" | "read-all" | "set" | "remove",
  action: () => Promise<T>,
): Promise<T> {
  try {
    return await action();
  } catch (error: unknown) {
    throw new StorageAdapterError(operation, error);
  }
}

/** Adapter boundary for chrome.storage.local; tests inject StorageAdapter directly. */
export function createChromeStorageAdapter(): StorageAdapter {
  return {
    get(keys) {
      return wrapStorageOperation("get", () => chrome.storage.local.get([...keys]));
    },
    readAll() {
      return wrapStorageOperation("read-all", () => chrome.storage.local.get());
    },
    async set(values) {
      await wrapStorageOperation("set", () => chrome.storage.local.set(values));
    },
    async remove(keys) {
      await wrapStorageOperation("remove", () => chrome.storage.local.remove([...keys]));
    },
  };
}
