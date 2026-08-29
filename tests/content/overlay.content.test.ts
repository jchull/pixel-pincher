import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("wxt/utils/define-content-script", () => ({
  defineContentScript: <T>(definition: T): T => definition,
}));

vi.mock("../../src/content/overlay-controller", () => ({
  OverlayController: class {
    hydrate(): Promise<void> {
      return Promise.resolve();
    }

    apply(): void {}

    clear(): void {}
  },
}));

import { startOverlayContent } from "../../entrypoints/overlay.content";
import { parseHydration } from "../../src/shared/parse";

const dataUrl = "data:image/png;base64,AQID";
const metadata = {
  id: "123e4567-e89b-42d3-a456-426614174000",
  name: "reference.png",
  mimeType: "image/png",
  width: 200,
  height: 100,
  encodedBytes: new TextEncoder().encode(dataUrl).byteLength,
  importedAt: 1,
};

function hydrationMessage(): unknown {
  const result = parseHydration({
    snapshot: {
      revision: 1,
      origin: "https://example.test",
      pageKey: "https://example.test/page",
      reference: metadata,
      settings: {
        visible: true,
        opacity: 0.5,
        inverted: false,
        placement: { x: 0, y: 0 },
        sizing: { kind: "scale", percent: 100 },
        interactionMode: "click-through",
      },
    },
    reference: { metadata, dataUrl },
  });
  if (!result.ok) throw new Error("Fixture failed validation.");
  return { kind: "hydrate-overlay", hydration: result.value };
}

describe("overlay content entrypoint", () => {
  let listener: ((message: unknown) => void) | undefined;
  let sendMessage: ReturnType<typeof vi.fn>;
  let buttons: HTMLButtonElement[];

  beforeEach(() => {
    document.getElementById("pixel-pincher-control-panel")?.remove();
    Reflect.deleteProperty(window, Symbol.for("pixel-pincher.overlay-controller"));
    Reflect.deleteProperty(window, Symbol.for("pixel-pincher.control-panel"));
    buttons = [];
    const createElement = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tagName: string) => {
      const created = createElement(tagName);
      if (created instanceof HTMLButtonElement) buttons.push(created);
      return created;
    });
    listener = undefined;
    sendMessage = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(globalThis, "chrome", {
      configurable: true,
      value: {
        runtime: {
          sendMessage,
          onMessage: {
            addListener: vi.fn((nextListener: (message: unknown) => void) => {
              listener = nextListener;
            }),
          },
        },
      },
    });
  });

  it("hydrates the in-page panel and sends its correlated sender-bound position request", () => {
    startOverlayContent();
    if (listener === undefined) throw new Error("Expected content message listener.");
    listener(hydrationMessage());

    const right = buttons.find((button) => button.dataset.direction === "right");
    if (right === undefined) throw new Error("Expected move-right control.");
    right.click();

    expect(sendMessage).toHaveBeenNthCalledWith(1, {
      kind: "content-ready",
      url: window.location.href,
    });
    expect(sendMessage).toHaveBeenLastCalledWith({
      kind: "update-panel-position",
      requestId: "panel-1",
      panelPosition: { x: 40, y: 24 },
    });
  });
});
