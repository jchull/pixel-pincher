import { describe, expect, it, vi } from "vitest";

import {
  PopupController,
  type PopupRuntimeAdapter,
  type PopupView,
} from "../../src/popup/popup-controller";
import type { PopupRequest, TabState } from "../../src/shared/contracts";
import { deriveOrigin, derivePageKey } from "../../src/shared/keys";

const url = "https://example.test/page";

function known<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(message);
  return value;
}

function tab(enabled: boolean): TabState {
  const parsed = new URL(url);
  const origin = known(deriveOrigin(parsed), "origin");
  return {
    tabId: 1,
    url,
    origin,
    enabled,
    snapshot: {
      revision: 1,
      origin,
      pageKey: known(derivePageKey(parsed), "page key"),
      reference: null,
      settings: {
        visible: true,
        opacity: 0.5,
        inverted: false,
        placement: { x: 0, y: 0 },
        sizing: { kind: "scale", percent: 100 },
        interactionMode: "click-through",
      },
    },
    diagnostic: null,
  };
}

type Harness = Readonly<{
  adapter: PopupRuntimeAdapter & { requests: PopupRequest[] };
  view: PopupView & { states: ReturnType<typeof vi.fn>; focus: ReturnType<typeof vi.fn> };
  controller: PopupController;
}>;

function createHarness(input: Readonly<{ enabled?: boolean; activeUrl?: string | null }> = {}): Harness {
  let current = tab(input.enabled ?? false);
  const requests: PopupRequest[] = [];
  const adapter: Harness["adapter"] = {
    requests,
    async getActiveUrl() {
      return input.activeUrl === undefined ? url : input.activeUrl;
    },
    async requestOrigin() {
      return true;
    },
    async send(request) {
      requests.push(request);
      if (request.kind === "get-tab-state")
        return { requestId: request.requestId, ok: true, value: current };
      if (request.kind === "register-site") {
        current = tab(true);
        return { requestId: request.requestId, ok: true, value: undefined };
      }
      current = tab(false);
      return { requestId: request.requestId, ok: true, value: undefined };
    },
  };
  const view: Harness["view"] = {
    states: vi.fn(),
    focus: vi.fn(),
    render: vi.fn(),
    restoreFocus: vi.fn(),
  };
  view.render = view.states;
  view.restoreFocus = view.focus;
  return {
    adapter,
    view,
    controller: new PopupController({ adapter, view }),
  };
}

describe("popup controller", () => {
  it("loads unsupported, access-required, and enabled states without overlay controls", async () => {
    const unsupported = createHarness({ activeUrl: "chrome://extensions/" });
    await unsupported.controller.start();
    expect(unsupported.controller.state.kind).toBe("unsupported");

    const harness = createHarness();
    await harness.controller.start();
    expect(harness.controller.state.kind).toBe("access-required");
    await harness.controller.enable();
    expect(harness.controller.state.kind).toBe("enabled");
    expect(harness.adapter.requests.map((request) => request.kind)).toEqual([
      "get-tab-state",
      "register-site",
    ]);
  });

  it("requests exact-origin access from enable and preserves a denial for retry", async () => {
    const harness = createHarness();
    const requestOrigin = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    harness.adapter.requestOrigin = requestOrigin;
    await harness.controller.start();
    await harness.controller.enable();
    expect(harness.controller.state).toMatchObject({
      kind: "error",
      error: { code: "site-access-denied" },
    });
    expect(requestOrigin).toHaveBeenCalledWith("https://example.test/*");
    await harness.controller.enable();
    expect(harness.controller.state.kind).toBe("enabled");
  });

  it("clears corrupt data and reloads the active tab state", async () => {
    const harness = createHarness();
    harness.adapter.send = async (request) => {
      harness.adapter.requests.push(request);
      if (request.kind === "get-tab-state")
        return {
          requestId: request.requestId,
          ok: false,
          error: {
            code: "invalid-stored-data",
            message: "Stored Pixel Pincher data is invalid. Clear this site's data and try again.",
          },
        };
      return { requestId: request.requestId, ok: true, value: undefined };
    };
    await harness.controller.start();
    expect(harness.controller.state).toMatchObject({
      kind: "error",
      error: { code: "invalid-stored-data" },
    });
    await harness.controller.clearCorruptSite();
    expect(harness.adapter.requests.map((request) => request.kind)).toEqual([
      "get-tab-state",
      "clear-site",
      "get-tab-state",
    ]);
  });

  it("rejects stale response IDs without dispatching a popup mutation", async () => {
    const harness = createHarness();
    harness.adapter.send = async (request) => {
      harness.adapter.requests.push(request);
      return { requestId: "stale", ok: true, value: tab(false) };
    };
    await harness.controller.start();
    expect(harness.controller.state).toMatchObject({
      kind: "error",
      error: { code: "invalid-request" },
    });
    expect(harness.adapter.requests.map((request) => request.kind)).toEqual([
      "get-tab-state",
    ]);
  });
});
