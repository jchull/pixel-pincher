import { describe, expect, it, vi } from "vitest";

import {
  createChromeStorageAdapter,
  StorageAdapterError,
} from "../../src/background/storage-adapter";

describe("createChromeStorageAdapter", () => {
  it("uses exact and full reads plus multi-key writes and removes", async () => {
    const get = vi.fn()
      .mockResolvedValueOnce({ first: 1 })
      .mockResolvedValueOnce({ first: 1, second: 2 });
    const set = vi.fn().mockResolvedValue(undefined);
    const remove = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(globalThis, "chrome", {
      configurable: true,
      value: { storage: { local: { get, remove, set } } },
      writable: true,
    });
    const adapter = createChromeStorageAdapter();

    await expect(adapter.get(["first"])).resolves.toEqual({ first: 1 });
    await expect(adapter.readAll()).resolves.toEqual({ first: 1, second: 2 });
    await adapter.set({ first: 1, second: 2 });
    await adapter.remove(["first", "second"]);

    expect(get).toHaveBeenNthCalledWith(1, ["first"]);
    expect(get).toHaveBeenNthCalledWith(2);
    expect(set).toHaveBeenCalledWith({ first: 1, second: 2 });
    expect(remove).toHaveBeenCalledWith(["first", "second"]);
  });

  it("contextualizes Chrome storage rejections", async () => {
    const get = vi.fn().mockRejectedValue(new Error("quota unavailable"));
    Object.defineProperty(globalThis, "chrome", {
      configurable: true,
      value: {
        storage: {
          local: {
            get,
            remove: vi.fn().mockResolvedValue(undefined),
            set: vi.fn().mockResolvedValue(undefined),
          },
        },
      },
      writable: true,
    });
    const adapter = createChromeStorageAdapter();

    await expect(adapter.readAll()).rejects.toEqual(
      expect.objectContaining({
        name: "StorageAdapterError",
        message: "Chrome storage read-all failed.",
      }),
    );
    await expect(adapter.get(["first"])).rejects.toBeInstanceOf(StorageAdapterError);
  });
});
