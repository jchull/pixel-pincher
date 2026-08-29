import { beforeEach, describe, expect, it, vi } from "vitest";

import { startOverlayContent } from "../../entrypoints/overlay.content";

let listener: ((message: unknown) => void) | undefined;
let sendMessage: ReturnType<typeof vi.fn>;

beforeEach(() => {
  document.documentElement.replaceChildren(
    document.createElement("head"),
    document.createElement("body"),
  );
  listener = undefined;
  sendMessage = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: {
      runtime: {
        onMessage: {
          addListener: vi.fn((candidate: (message: unknown) => void) => {
            listener = candidate;
          }),
        },
        sendMessage,
      },
    },
  });
});

describe("overlay content entrypoint", () => {
  it("starts once, announces readiness, and ignores malformed messages", () => {
    const first = startOverlayContent(window);
    const second = startOverlayContent(window);
    expect(second).toBe(first);
    expect(sendMessage).toHaveBeenCalledWith({
      kind: "content-ready",
      url: window.location.href,
    });
    if (listener === undefined)
      throw new Error("Expected content message listener.");
    listener({ kind: "clear-overlay", revision: -1 });
    expect(document.querySelectorAll("#pixel-pincher-overlay")).toHaveLength(1);
  });
});
