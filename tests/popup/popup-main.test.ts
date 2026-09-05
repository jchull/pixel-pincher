import { beforeEach, describe, expect, it, vi } from "vitest";

const url = "https://example.test/next-page";

function enabledTab() {
  return {
    tabId: 1,
    url,
    origin: "https://example.test",
    enabled: true,
    snapshot: {
      revision: 1,
      origin: "https://example.test",
      pageKey: url,
      reference: null,
      settings: {
        visible: false,
        opacity: 0.5,
        inverted: false,
        placement: { x: 0, y: 0 },
        sizing: { kind: "scale" as const, percent: 100 },
        interactionMode: "click-through" as const,
      },
    },
    diagnostic: null,
  };
}

beforeEach(() => {
  vi.resetModules();
  document.documentElement.replaceChildren(
    document.createElement("head"),
    document.createElement("body"),
  );
  const root = document.createElement("main");
  root.id = "popup-root";
  document.body.append(root);
});

describe("popup panel toggle", () => {
  it("refreshes and shows controls after navigation starts before panel injection", async () => {
    let stateRequests = 0;
    const sendMessage = vi.fn(async (request: { kind: string; requestId: string }) => {
      if (request.kind === "get-tab-state") {
        stateRequests += 1;
        if (stateRequests === 2) {
          const panel = document.createElement("pixel-pincher-control-panel");
          panel.id = "pixel-pincher-control-panel";
          panel.style.display = "none";
          document.documentElement.append(panel);
        }
        return { requestId: request.requestId, ok: true, value: enabledTab() };
      }
      return { requestId: request.requestId, ok: true, value: undefined };
    });
    const executeScript = vi.fn(async (details: {
      func: (...args: unknown[]) => unknown;
      args?: unknown[];
    }) => {
      // Chrome serializes the function rather than preserving module bindings.
      const serialized = new Function(
        `return (${details.func.toString()});`,
      )() as (...args: unknown[]) => unknown;
      return [{ result: serialized(...(details.args ?? [])) }];
    });
    Object.defineProperty(globalThis, "chrome", {
      configurable: true,
      value: {
        permissions: { request: vi.fn() },
        runtime: { sendMessage },
        scripting: { executeScript },
        tabs: { query: vi.fn().mockResolvedValue([{ id: 1, url }]) },
      },
    });

    await import("../../entrypoints/popup/main");
    await vi.waitFor(() => {
      expect(
        document.querySelector<HTMLButtonElement>("#toggle-panel")?.textContent,
      ).toBe("Show in-page controls");
    });
    const toggle = document.querySelector<HTMLButtonElement>("#toggle-panel");
    if (toggle === null) throw new Error("Expected panel toggle.");
    toggle.click();

    await vi.waitFor(() => {
      expect(
        document.getElementById("pixel-pincher-control-panel")?.style.display,
      ).toBe("block");
      expect(toggle.textContent).toBe("Hide in-page controls");
    });
    expect(stateRequests).toBe(2);
  });
});
