import { beforeEach, describe, expect, it, vi } from "vitest";

const lifecycle = vi.hoisted(() => {
  type MessageListener = (message: unknown, sender: chrome.runtime.MessageSender, sendResponse: (response?: unknown) => void) => boolean | undefined;
  const installedListeners: Array<() => void> = [];
  const permissionRemovedListeners: Array<() => void> = [];
  const messageListeners: MessageListener[] = [];
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
        id: "pixel-pincher-test",
        onMessage: {
          addListener(listener: (message: unknown, sender: chrome.runtime.MessageSender, sendResponse: (response?: unknown) => void) => boolean | undefined) {
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
      tabs: {
        query: vi.fn().mockResolvedValue([{ id: 1, url: "https://example.test/page" }]),
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

    const messageListener = lifecycle.messageListeners[0];
    if (messageListener === undefined) throw new Error("Message listener must be registered.");
    const respond = vi.fn();
    const tabSender: chrome.runtime.MessageSender = {
      id: "pixel-pincher-test",
      tab: { active: true, autoDiscardable: true, discarded: false, frozen: false, groupId: -1, highlighted: true, id: 1, incognito: false, index: 0, pinned: false, selected: true, windowId: 1 },
      frameId: 0,
      url: "https://example.test/page",
    };
    expect(messageListener({ kind: "get-tab-state", requestId: "tab-request" }, tabSender, respond)).toBeUndefined();
    expect(respond).toHaveBeenCalledWith(expect.objectContaining({ error: expect.objectContaining({ code: "invalid-request" }) }));
    respond.mockClear();
    const foreignSender: chrome.runtime.MessageSender = { id: "other-extension" };
    expect(messageListener({ kind: "get-tab-state", requestId: "foreign-request" }, foreignSender, respond)).toBeUndefined();
    expect(respond).toHaveBeenCalledWith(expect.objectContaining({ error: expect.objectContaining({ code: "invalid-request" }) }));
    respond.mockClear();
    const popupSender: chrome.runtime.MessageSender = { id: "pixel-pincher-test" };
    expect(messageListener({ kind: "get-tab-state", requestId: "popup-request" }, popupSender, respond)).toBe(true);

    for (const listener of lifecycle.startupListeners) listener();
    for (const listener of lifecycle.installedListeners) listener();
    for (const listener of lifecycle.permissionRemovedListeners) listener();
    await Promise.resolve();
    await Promise.resolve();

    expect(lifecycle.cleanupOrphans).toHaveBeenCalledTimes(3);
    expect(lifecycle.reconcile).toHaveBeenCalledTimes(3);
  });
});
