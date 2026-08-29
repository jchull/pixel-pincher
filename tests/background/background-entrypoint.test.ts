import { beforeEach, describe, expect, it, vi } from "vitest";

const lifecycle = vi.hoisted(() => {
  const installedListeners: Array<() => void> = [];
  const permissionRemovedListeners: Array<() => void> = [];
  const messageListeners: Array<() => void> = [];
  const startupListeners: Array<() => void> = [];

  return {
    cleanupOrphans: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
    installedListeners,
    messageListeners,
    permissionRemovedListeners,
    reconcile: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
    startupListeners,
  };
});

vi.mock("wxt/utils/define-background", () => ({
  defineBackground(main: () => void) {
    main();
    return undefined;
  },
}));

vi.mock("../../src/background/repository", () => ({
  OverlayRepository: class {
    cleanupOrphans = lifecycle.cleanupOrphans;
  },
}));

vi.mock("../../src/background/site-access", () => ({
  createChromeSiteAccessAdapter: vi.fn(),
  SiteAccessService: class {
    reconcile = lifecycle.reconcile;
  },
}));

vi.mock("../../src/background/storage-adapter", () => ({
  createChromeStorageAdapter: vi.fn(),
}));

beforeEach(() => {
  lifecycle.cleanupOrphans.mockClear();
  lifecycle.installedListeners.length = 0;
  lifecycle.messageListeners.length = 0;
  lifecycle.permissionRemovedListeners.length = 0;
  lifecycle.reconcile.mockClear();
  lifecycle.startupListeners.length = 0;

  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: {
      permissions: {
        onRemoved: {
          addListener(listener: () => void) {
            lifecycle.permissionRemovedListeners.push(listener);
          },
        },
      },
      runtime: {
        onMessage: {
          addListener(listener: () => void) {
            lifecycle.messageListeners.push(listener);
          },
        },
        onInstalled: {
          addListener(listener: () => void) {
            lifecycle.installedListeners.push(listener);
          },
        },
        onStartup: {
          addListener(listener: () => void) {
            lifecycle.startupListeners.push(listener);
          },
        },
      },
    },
    writable: true,
  });
});

describe("background entrypoint lifecycle", () => {
  it("reconciles on startup, install, and optional-origin permission removal", async () => {
    await import("../../entrypoints/background");

    expect(lifecycle.startupListeners).toHaveLength(1);
    expect(lifecycle.installedListeners).toHaveLength(1);
    expect(lifecycle.permissionRemovedListeners).toHaveLength(1);
    expect(lifecycle.messageListeners).toHaveLength(1);

    for (const listener of lifecycle.startupListeners) listener();
    for (const listener of lifecycle.installedListeners) listener();
    for (const listener of lifecycle.permissionRemovedListeners) listener();
    await Promise.resolve();
    await Promise.resolve();

    expect(lifecycle.cleanupOrphans).toHaveBeenCalledTimes(3);
    expect(lifecycle.reconcile).toHaveBeenCalledTimes(3);
  });
});
