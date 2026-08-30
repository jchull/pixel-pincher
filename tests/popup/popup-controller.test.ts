import { describe, expect, it, vi } from "vitest";

import {
  PopupController,
  type PopupImporter,
  type PopupRuntimeAdapter,
  type PopupView,
} from "../../src/popup/popup-controller";
import type {
  ImportedReference,
  OverlaySnapshot,
  PopupRequest,
  SettingsPatch,
  TabState,
} from "../../src/shared/contracts";
import { deriveOrigin, derivePageKey } from "../../src/shared/keys";
import { parseImportedReference } from "../../src/shared/parse";

const url = "https://example.test/page";

function known<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(message);
  return value;
}

function reference(): ImportedReference {
  const parsed = parseImportedReference({
    metadata: {
      id: "123e4567-e89b-42d3-a456-426614174000",
      name: "reference.png",
      mimeType: "image/png",
      width: 20,
      height: 10,
      encodedBytes: 26,
      importedAt: 1,
    },
    dataUrl: "data:image/png;base64,AA==",
  });
  if (!parsed.ok) throw new Error("Reference fixture must parse.");
  return parsed.value;
}

function snapshot(
  input: Readonly<{
    reference?: ImportedReference | null;
    settings?: Partial<OverlaySnapshot["settings"]>;
    revision?: number;
  }> = {},
): OverlaySnapshot {
  const parsed = new URL(url);
  const imported =
    input.reference === undefined ? reference() : input.reference;
  return {
    revision: input.revision ?? 1,
    origin: known(deriveOrigin(parsed), "origin"),
    pageKey: known(derivePageKey(parsed), "page key"),
    reference: imported?.metadata ?? null,
    settings: {
      visible: input.settings?.visible ?? true,
      opacity: input.settings?.opacity ?? 0.5,
      inverted: input.settings?.inverted ?? false,
      placement: input.settings?.placement ?? { x: 0, y: 0 },
      sizing: input.settings?.sizing ?? {
        kind: "fit-width",
        lastScalePercent: 100,
      },
      interactionMode: input.settings?.interactionMode ?? "click-through",
    },
  };
}

function tab(
  input: Readonly<{ enabled?: boolean; snapshot?: OverlaySnapshot }> = {},
): TabState {
  const current = input.snapshot ?? snapshot();
  return {
    tabId: 1,
    url,
    origin: current.origin,
    enabled: input.enabled ?? true,
    snapshot: current,
    diagnostic: null,
  };
}

function applyPatch(
  current: OverlaySnapshot,
  patch: SettingsPatch,
): OverlaySnapshot {
  const settings =
    patch.kind === "visibility"
      ? { ...current.settings, visible: patch.visible }
      : patch.kind === "opacity"
        ? { ...current.settings, opacity: patch.opacity }
        : patch.kind === "inversion"
          ? { ...current.settings, inverted: patch.inverted }
          : patch.kind === "sizing"
            ? { ...current.settings, sizing: patch.sizing }
            : patch.kind === "interaction-mode"
              ? { ...current.settings, interactionMode: patch.interactionMode }
              : { ...current.settings, placement: patch.placement };
  return { ...current, revision: current.revision + 1, settings };
}

type Harness = Readonly<{
  adapter: PopupRuntimeAdapter & {
    requests: PopupRequest[];
    resolveNext: ((value: unknown) => void) | undefined;
  };
  view: PopupView & {
    states: ReturnType<typeof vi.fn>;
    focus: ReturnType<typeof vi.fn>;
  };
  controller: PopupController;
}>;

function createHarness(
  input: Readonly<{
    activeUrl?: string | null;
    enabled?: boolean;
    importer?: PopupImporter;
    pauseSettings?: boolean;
  }> = {},
): Harness {
  let current = tab({ enabled: input.enabled });
  let held: ((value: unknown) => void) | undefined;
  const requests: PopupRequest[] = [];
  const adapter: Harness["adapter"] = {
    requests,
    resolveNext: undefined,
    async getActiveUrl() {
      return input.activeUrl === undefined ? url : input.activeUrl;
    },
    async requestOrigin() {
      return true;
    },
    send(request) {
      requests.push(request);
      if (
        input.pauseSettings &&
        request.kind === "update-settings" &&
        held === undefined
      ) {
        return new Promise((resolve) => {
          held = resolve;
          adapter.resolveNext = resolve;
        });
      }
      if (request.kind === "get-tab-state")
        return Promise.resolve({
          requestId: request.requestId,
          ok: true,
          value: current,
        });
      if (request.kind === "register-site") {
        current = { ...current, enabled: true };
        return Promise.resolve({
          requestId: request.requestId,
          ok: true,
          value: current.snapshot,
        });
      }
      if (request.kind === "update-settings") {
        current = {
          ...current,
          snapshot: applyPatch(current.snapshot, request.patch),
        };
        return Promise.resolve({
          requestId: request.requestId,
          ok: true,
          value: current.snapshot,
        });
      }
      if (request.kind === "replace-reference") {
        current = {
          ...current,
          snapshot: {
            ...current.snapshot,
            reference: request.reference.metadata,
            revision: current.snapshot.revision + 1,
          },
        };
        return Promise.resolve({
          requestId: request.requestId,
          ok: true,
          value: current.snapshot,
        });
      }
      current = {
        ...current,
        enabled: false,
        snapshot: snapshot({ reference: null }),
      };
      return Promise.resolve({
        requestId: request.requestId,
        ok: true,
        value: undefined,
      });
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
  const importer =
    input.importer ??
    vi.fn(async () => ({ ok: true as const, value: reference() }));
  return {
    adapter,
    view,
    controller: new PopupController({ adapter, view, importer }),
  };
}

async function settled(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("popup controller", () => {
  it("renders unsupported, access-required, empty, and reference states", async () => {
    const unsupported = createHarness({ activeUrl: "chrome://extensions" });
    await unsupported.controller.start();
    expect(unsupported.controller.state.kind).toBe("unsupported");

    const access = createHarness({ enabled: false });
    await access.controller.start();
    expect(access.controller.state.kind).toBe("access-required");
    await access.controller.enable();
    expect(access.controller.state.kind).toBe("enabled-reference");

    const empty = createHarness();
    empty.adapter.send = async (request) =>
      request.kind === "get-tab-state"
        ? {
            requestId: request.requestId,
            ok: true,
            value: tab({ snapshot: snapshot({ reference: null }) }),
          }
        : { requestId: request.requestId, ok: true, value: undefined };
    await empty.controller.start();
    expect(empty.controller.state.kind).toBe("enabled-empty");
  });

  it("keeps permission denial as an error and retries access on a later direct action", async () => {
    const harness = createHarness({ enabled: false });
    const requestOrigin = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    harness.adapter.requestOrigin = requestOrigin;
    await harness.controller.start();
    await harness.controller.enable();
    expect(harness.controller.state.kind).toBe("error");
    await harness.controller.enable();
    expect(requestOrigin).toHaveBeenCalledTimes(2);
    expect(harness.controller.state.kind).toBe("enabled-reference");
  });

  it("retains stable import errors, then imports a successful replacement", async () => {
    const importer = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        error: {
          code: "image-decode-failed",
          message: "Pixel Pincher could not decode that image.",
        },
      })
      .mockResolvedValueOnce({ ok: true, value: reference() });
    const harness = createHarness({ importer });
    await harness.controller.start();
    await harness.controller.importFile(
      new File(["x"], "bad.png", { type: "image/png" }),
    );
    expect(harness.controller.state.kind).toBe("error");
    await harness.controller.importFile(
      new File(["x"], "good.png", { type: "image/png" }),
    );
    expect(
      harness.adapter.requests.some(
        (request) => request.kind === "replace-reference",
      ),
    ).toBe(true);
    expect(harness.view.focus).toHaveBeenCalledWith("reference-file");
  });

  it("shows a decode error when the browser image decoder throws", async () => {
    const harness = createHarness({
      importer: vi
        .fn()
        .mockRejectedValue(new Error("CSP blocked image decoding")),
    });
    await harness.controller.start();
    await harness.controller.importFile(
      new File(["x"], "reference.png", { type: "image/png" }),
    );
    expect(harness.controller.state).toMatchObject({
      kind: "error",
      error: { code: "image-decode-failed" },
    });
  });

  it("rejects stale correlated responses and preserves the error until a user action", async () => {
    const harness = createHarness();
    harness.adapter.send = async (request) => ({
      requestId: `${request.requestId}-stale`,
      ok: true,
      value: tab(),
    });
    await harness.controller.start();
    expect(harness.controller.state.kind).toBe("error");
    await harness.controller.retry();
    expect(harness.controller.state.kind).toBe("error");
  });

  it("coalesces opacity updates to the latest value and allows transparency endpoints", async () => {
    const harness = createHarness({ pauseSettings: true });
    await harness.controller.start();
    harness.controller.setOpacity(0);
    harness.controller.setOpacity(55);
    harness.controller.setOpacity(100);
    expect(
      harness.adapter.requests.filter(
        (request) => request.kind === "update-settings",
      ),
    ).toHaveLength(1);
    const first = harness.adapter.requests.at(-1);
    if (first?.kind !== "update-settings")
      throw new Error("settings request expected");
    harness.adapter.resolveNext?.({
      requestId: first.requestId,
      ok: true,
      value: snapshot({ settings: { opacity: 0 } }),
    });
    await settled();
    const updates = harness.adapter.requests.filter(
      (request) => request.kind === "update-settings",
    );
    expect(updates).toHaveLength(2);
    expect(updates[1]).toMatchObject({
      patch: { kind: "opacity", opacity: 1 },
    });
  });

  it("preserves manual scale across fit width, clamps sizing, resets, and updates inversion", async () => {
    const harness = createHarness();
    await harness.controller.start();
    harness.controller.setSizingPercent(150);
    await settled();
    harness.controller.setFitWidth(true);
    await settled();
    harness.controller.setFitWidth(false);
    await settled();
    harness.controller.setSizingPercent(999);
    harness.controller.resetScale();
    harness.controller.updateSettings(
      { kind: "inversion", inverted: true },
      "inverted",
    );
    await settled();
    const patches = harness.adapter.requests
      .filter(
        (
          request,
        ): request is Extract<PopupRequest, { kind: "update-settings" }> =>
          request.kind === "update-settings",
      )
      .map((request) => request.patch);
    expect(patches).toContainEqual({
      kind: "sizing",
      sizing: { kind: "fit-width", lastScalePercent: 150 },
    });
    expect(patches).toContainEqual({
      kind: "sizing",
      sizing: { kind: "scale", percent: 150 },
    });
    expect(patches).toContainEqual({
      kind: "sizing",
      sizing: { kind: "scale", percent: 600 },
    });
    expect(patches).toContainEqual({
      kind: "sizing",
      sizing: { kind: "scale", percent: 100 },
    });
    expect(patches).toContainEqual({ kind: "inversion", inverted: true });
  });

  it("parses integer controls, supports keyboard steps, and requires clear confirmation", async () => {
    const harness = createHarness();
    await harness.controller.start();
    harness.controller.commitNumber("x", "not a number", "x");
    harness.controller.commitNumber("x", "12", "x");
    harness.controller.stepNumber("y", 1, true, "y");
    harness.controller.stepNumber("scale", -1, true, "scale-number");
    await settled();
    expect(
      harness.adapter.requests.filter(
        (request) => request.kind === "update-settings",
      ),
    ).toHaveLength(3);
    harness.controller.clearSite();
    expect(
      harness.adapter.requests.some((request) => request.kind === "clear-site"),
    ).toBe(false);
    harness.controller.toggleClearConfirmation();
    expect(harness.controller.state).toMatchObject({ confirmingClear: true });
    await harness.controller.clearSite();
    expect(
      harness.adapter.requests.some((request) => request.kind === "clear-site"),
    ).toBe(true);
  });

  it("clamps manual placement at the shared limits before sending it", async () => {
    const harness = createHarness();
    await harness.controller.start();
    harness.controller.commitNumber("x", "1000001", "x");
    harness.controller.commitNumber("y", "-1000001", "y");
    await settled();
    const patches = harness.adapter.requests
      .filter(
        (
          request,
        ): request is Extract<PopupRequest, { kind: "update-settings" }> =>
          request.kind === "update-settings",
      )
      .map((request) => request.patch);
    expect(patches).toContainEqual({
      kind: "placement",
      placement: { x: 1_000_000, y: 0 },
    });
    expect(patches).toContainEqual({
      kind: "placement",
      placement: { x: 1_000_000, y: -1_000_000 },
    });
  });

  it("builds queued placement changes from the latest intended placement", async () => {
    const harness = createHarness({ pauseSettings: true });
    await harness.controller.start();
    harness.controller.commitNumber("x", "12", "x");
    harness.controller.commitNumber("y", "34", "y");
    const first = known(
      harness.adapter.requests.find(
        (request) => request.kind === "update-settings",
      ),
      "first placement request",
    );
    if (first.kind !== "update-settings")
      throw new Error("settings request expected");
    harness.adapter.resolveNext?.({
      requestId: first.requestId,
      ok: true,
      value: snapshot({ settings: { placement: { x: 12, y: 0 } } }),
    });
    await settled();
    const updates = harness.adapter.requests.filter(
      (
        request,
      ): request is Extract<PopupRequest, { kind: "update-settings" }> =>
        request.kind === "update-settings",
    );
    expect(updates[1]).toMatchObject({
      patch: { kind: "placement", placement: { x: 12, y: 34 } },
    });
  });

  it("preserves the latest manual scale while a sizing mutation is in flight", async () => {
    const harness = createHarness({ pauseSettings: true });
    await harness.controller.start();
    harness.controller.setSizingPercent(175);
    harness.controller.setFitWidth(true);
    const first = known(
      harness.adapter.requests.find(
        (request) => request.kind === "update-settings",
      ),
      "first sizing request",
    );
    if (first.kind !== "update-settings")
      throw new Error("settings request expected");
    harness.adapter.resolveNext?.({
      requestId: first.requestId,
      ok: true,
      value: snapshot({
        settings: { sizing: { kind: "scale", percent: 175 } },
      }),
    });
    await settled();
    const updates = harness.adapter.requests.filter(
      (
        request,
      ): request is Extract<PopupRequest, { kind: "update-settings" }> =>
        request.kind === "update-settings",
    );
    expect(updates[1]).toMatchObject({
      patch: {
        kind: "sizing",
        sizing: { kind: "fit-width", lastScalePercent: 175 },
      },
    });
  });

  it("uses a confirmed snapshot rather than a stale sizing intent for the next action", async () => {
    const harness = createHarness({ pauseSettings: true });
    await harness.controller.start();
    harness.controller.setSizingPercent(175);
    const first = known(
      harness.adapter.requests.find(
        (request) => request.kind === "update-settings",
      ),
      "sizing request",
    );
    if (first.kind !== "update-settings")
      throw new Error("settings request expected");
    harness.adapter.resolveNext?.({
      requestId: first.requestId,
      ok: true,
      value: snapshot({
        settings: { sizing: { kind: "scale", percent: 200 } },
      }),
    });
    await settled();
    harness.controller.setFitWidth(true);
    await settled();
    const updates = harness.adapter.requests.filter(
      (
        request,
      ): request is Extract<PopupRequest, { kind: "update-settings" }> =>
        request.kind === "update-settings",
    );
    expect(updates.at(-1)).toMatchObject({
      patch: {
        kind: "sizing",
        sizing: { kind: "fit-width", lastScalePercent: 200 },
      },
    });
  });

  it("drops queued settings when the active mutation fails", async () => {
    const harness = createHarness({ pauseSettings: true });
    await harness.controller.start();
    harness.controller.commitNumber("x", "12", "x");
    harness.controller.commitNumber("y", "34", "y");
    const first = known(
      harness.adapter.requests.find(
        (request) => request.kind === "update-settings",
      ),
      "first placement request",
    );
    if (first.kind !== "update-settings")
      throw new Error("settings request expected");
    harness.adapter.resolveNext?.({
      requestId: first.requestId,
      ok: false,
      error: {
        code: "storage-failed",
        message: "Pixel Pincher could not save this change.",
      },
    });
    await settled();
    expect(harness.controller.state).toMatchObject({
      kind: "error",
      error: { code: "storage-failed" },
    });
    expect(
      harness.adapter.requests.filter(
        (request) => request.kind === "update-settings",
      ),
    ).toHaveLength(1);
  });

  it("drops optimistic sizing intent after a failed mutation", async () => {
    const harness = createHarness({ pauseSettings: true });
    await harness.controller.start();
    harness.controller.setSizingPercent(175);
    const first = known(
      harness.adapter.requests.find(
        (request) => request.kind === "update-settings",
      ),
      "sizing request",
    );
    if (first.kind !== "update-settings")
      throw new Error("settings request expected");
    harness.adapter.resolveNext?.({
      requestId: first.requestId,
      ok: false,
      error: {
        code: "storage-failed",
        message: "Pixel Pincher could not save this change.",
      },
    });
    await settled();
    await harness.controller.retry();
    harness.controller.setFitWidth(false);
    await settled();
    const updates = harness.adapter.requests.filter(
      (
        request,
      ): request is Extract<PopupRequest, { kind: "update-settings" }> =>
        request.kind === "update-settings",
    );
    expect(updates.at(-1)).toMatchObject({
      patch: { kind: "sizing", sizing: { kind: "scale", percent: 100 } },
    });
  });

  it("allows the corrupt-data recovery state to clear the site without confirmation", async () => {
    const harness = createHarness({ enabled: false });
    harness.adapter.send = vi.fn(async (request) => {
      if (request.kind === "get-tab-state") {
        return {
          requestId: request.requestId,
          ok: false,
          error: {
            code: "invalid-stored-data",
            message:
              "Stored Pixel Pincher data is invalid. Clear this site's data and try again.",
          },
        };
      }
      if (request.kind === "clear-site")
        return { requestId: request.requestId, ok: true, value: undefined };
      throw new Error(`Unexpected request: ${request.kind}`);
    });
    await harness.controller.start();
    expect(harness.controller.state).toMatchObject({
      kind: "error",
      recovery: { kind: "access-required" },
    });
    await harness.controller.clearSite("clear-corrupt-site");
    expect(harness.adapter.send).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "clear-site", url }),
    );
  });
});
