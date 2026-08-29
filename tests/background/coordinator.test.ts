import { describe, expect, it, vi } from "vitest";

import { BackgroundCoordinator, type ActiveTab, type TabResolver } from "../../src/background/coordinator";
import { TabMessenger } from "../../src/background/tab-messenger";
import type { Hydration, ImportedReference, OverlaySnapshot } from "../../src/shared/contracts";
import { deriveOrigin, derivePageKey } from "../../src/shared/keys";
import { parseImportedReference } from "../../src/shared/parse";

const pageUrl = "https://example.test/page#one";
const pageUrlWithOtherHash = "https://example.test/page#two";
const otherPageUrl = "https://example.test/other";

function known<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw new Error(message);
  return value;
}

function reference(id = "123e4567-e89b-42d3-a456-426614174000"): ImportedReference {
  const dataUrl = "data:image/png;base64,aGVsbG8=";
  const parsed = parseImportedReference({
    metadata: { id, name: "reference.png", mimeType: "image/png", width: 1, height: 1, encodedBytes: new TextEncoder().encode(dataUrl).byteLength, importedAt: 1 },
    dataUrl,
  });
  if (!parsed.ok) throw new Error("Test reference must parse.");
  return parsed.value;
}

function snapshot(input: Readonly<{ reference?: ImportedReference | null; revision?: number; url?: string }> = {}): OverlaySnapshot {
  const url = new URL(input.url ?? pageUrl);
  return {
    revision: input.revision ?? 3,
    origin: known(deriveOrigin(url), "Known URL must have an origin."),
    pageKey: known(derivePageKey(url), "Known URL must have a page key."),
    settings: {
      visible: true,
      opacity: 0.5,
      inverted: false,
      placement: { x: 0, y: 0 },
      sizing: { kind: "fit-width", lastScalePercent: 100 },
      interactionMode: "click-through",
    },
    reference: input.reference === undefined || input.reference === null ? null : input.reference.metadata,
  };
}

class FakeTabs implements TabResolver {
  active: ActiveTab | null = { id: 9, url: pageUrl };
  readonly tabs = new Map<number, ActiveTab>([[9, { id: 9, url: pageUrl }]]);

  async getActiveTab(): Promise<ActiveTab | null> {
    return this.active;
  }

  async getTab(tabId: number): Promise<ActiveTab | null> {
    return this.tabs.get(tabId) ?? null;
  }
}

function createCoordinator(input: Readonly<{ currentSnapshot?: OverlaySnapshot; enabled?: boolean }> = {}) {
  const tabs = new FakeTabs();
  let currentSnapshot = input.currentSnapshot ?? snapshot();
  let hydrationReference: ImportedReference | null = null;
  const hydration = (): Hydration => currentSnapshot.reference === null
    ? { snapshot: { ...currentSnapshot, reference: null }, reference: null }
    : { snapshot: { ...currentSnapshot, reference: known(hydrationReference, "Reference must be available.").metadata }, reference: known(hydrationReference, "Reference must be available.") };
  const repository = {
    cleanupOrphans: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
    clearOrigin: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
    readHydration: vi.fn().mockImplementation(async () => ({ ok: true as const, value: hydration() })),
    readSnapshot: vi.fn().mockImplementation(async () => ({ ok: true as const, value: currentSnapshot })),
    replaceReference: vi.fn().mockImplementation(async ({ reference: next }: { reference: ImportedReference }) => {
      hydrationReference = next;
      currentSnapshot = snapshot({ reference: next, revision: currentSnapshot.revision + 1 });
      return { ok: true as const, value: currentSnapshot };
    }),
    updatePlacement: vi.fn().mockImplementation(async ({ placement }: { placement: { x: number; y: number } }) => {
      currentSnapshot = { ...currentSnapshot, revision: currentSnapshot.revision + 1, settings: { ...currentSnapshot.settings, placement } };
      return { ok: true as const, value: currentSnapshot };
    }),
    updateSettings: vi.fn().mockImplementation(async () => {
      currentSnapshot = { ...currentSnapshot, revision: currentSnapshot.revision + 1 };
      return { ok: true as const, value: currentSnapshot };
    }),
  };
  const siteAccess = {
    ensureForUrl: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
    has: vi.fn().mockResolvedValue({ ok: true, value: input.enabled ?? true }),
    injectForUrl: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
    reconcile: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
    unregisterOrigin: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
  };
  const send = vi.fn().mockResolvedValue(undefined);
  const messenger = new TabMessenger({ send }, { inject: vi.fn().mockResolvedValue({ ok: true, value: undefined }) });
  return { coordinator: new BackgroundCoordinator({ repository, siteAccess, tabs, messenger }), repository, send, siteAccess, tabs, setSnapshot: (next: OverlaySnapshot) => { currentSnapshot = next; } };
}

describe("BackgroundCoordinator", () => {
  it("routes all popup mutations to the active canonical page and delivers their resulting state", async () => {
    const harness = createCoordinator();
    const imported = reference();

    await expect(harness.coordinator.handlePopup({ kind: "get-tab-state", requestId: "state" })).resolves.toMatchObject({ ok: true });
    await expect(harness.coordinator.handlePopup({ kind: "register-site", requestId: "register", url: pageUrlWithOtherHash })).resolves.toEqual({ requestId: "register", ok: true, value: undefined });
    await expect(harness.coordinator.handlePopup({ kind: "replace-reference", requestId: "replace", url: pageUrlWithOtherHash, reference: imported })).resolves.toMatchObject({ ok: true });
    await expect(harness.coordinator.handlePopup({ kind: "update-settings", requestId: "update", url: pageUrlWithOtherHash, patch: { kind: "opacity", opacity: 0.7 } })).resolves.toMatchObject({ ok: true });
    await expect(harness.coordinator.handlePopup({ kind: "clear-site", requestId: "clear", url: pageUrlWithOtherHash })).resolves.toEqual({ requestId: "clear", ok: true, value: undefined });

    expect(harness.repository.replaceReference).toHaveBeenCalledOnce();
    expect(harness.repository.updateSettings).toHaveBeenCalledOnce();
    expect(harness.repository.clearOrigin).toHaveBeenCalledOnce();
    expect(harness.siteAccess.ensureForUrl).toHaveBeenCalledOnce();
    expect(harness.siteAccess.unregisterOrigin).toHaveBeenCalledOnce();
    expect(harness.send.mock.calls.map(([, request]) => request.kind)).toEqual(["hydrate-overlay", "apply-settings", "clear-overlay"]);
  });

  it("rejects a different canonical page and rechecks the active tab before mutation, delivery, and response", async () => {
    const harness = createCoordinator();
    await expect(harness.coordinator.handlePopup({ kind: "update-settings", requestId: "wrong", url: otherPageUrl, patch: { kind: "opacity", opacity: 0.7 } })).resolves.toMatchObject({ ok: false, error: { code: "invalid-request" } });
    expect(harness.repository.updateSettings).not.toHaveBeenCalled();

    const originalGetActiveTab = harness.tabs.getActiveTab.bind(harness.tabs);
    let activeReads = 0;
    harness.tabs.getActiveTab = async () => {
      activeReads += 1;
      return activeReads === 1 ? originalGetActiveTab() : { id: 10, url: otherPageUrl };
    };
    await expect(harness.coordinator.handlePopup({ kind: "update-settings", requestId: "moved", url: pageUrl, patch: { kind: "opacity", opacity: 0.7 } })).resolves.toMatchObject({ ok: false, error: { code: "invalid-request" } });
    expect(harness.repository.updateSettings).not.toHaveBeenCalled();
    expect(harness.send).not.toHaveBeenCalled();

    const afterMutation = createCoordinator();
    const activeTab = afterMutation.tabs.active;
    if (activeTab === null) throw new Error("Test needs an active tab.");
    let responseBoundaryReads = 0;
    afterMutation.tabs.getActiveTab = async () => {
      responseBoundaryReads += 1;
      return responseBoundaryReads <= 2 ? activeTab : { id: 10, url: otherPageUrl };
    };
    await expect(afterMutation.coordinator.handlePopup({ kind: "update-settings", requestId: "after-mutation", url: pageUrl, patch: { kind: "opacity", opacity: 0.7 } })).resolves.toMatchObject({ ok: false, error: { code: "invalid-request" } });
    expect(afterMutation.repository.updateSettings).toHaveBeenCalledOnce();
    expect(afterMutation.send).not.toHaveBeenCalled();
  });

  it("sends a clear revision newer than both stored and previously delivered state", async () => {
    const harness = createCoordinator({ currentSnapshot: snapshot({ revision: 7 }) });
    await expect(harness.coordinator.handlePopup({ kind: "clear-site", requestId: "clear", url: pageUrl })).resolves.toMatchObject({ ok: true });
    expect(harness.send).toHaveBeenCalledWith(9, { kind: "clear-overlay", revision: 8 });
  });

  it("requires current site access before content mutations and only retains matching image diagnostics", async () => {
    const imported = reference();
    const denied = createCoordinator({ currentSnapshot: snapshot({ reference: imported }), enabled: false });
    await denied.coordinator.handleContent({ kind: "placement-committed", url: pageUrl, placement: { x: 4, y: 5 } }, { tabId: 9, frameId: 0, url: pageUrl });
    await denied.coordinator.handleContent({ kind: "image-load-failed", url: pageUrl, referenceId: imported.metadata.id }, { tabId: 9, frameId: 0, url: pageUrl });
    expect(denied.repository.updatePlacement).not.toHaveBeenCalled();
    expect(denied.repository.readSnapshot).toHaveBeenCalledOnce();

    const harness = createCoordinator({ currentSnapshot: snapshot({ reference: imported }) });
    await harness.coordinator.handleContent({ kind: "image-load-failed", url: pageUrl, referenceId: imported.metadata.id }, { tabId: 9, frameId: 0, url: pageUrl });
    await expect(harness.coordinator.handlePopup({ kind: "get-tab-state", requestId: "matching" })).resolves.toMatchObject({ value: { diagnostic: { referenceId: imported.metadata.id } } });

    const anotherReference = reference("223e4567-e89b-42d3-a456-426614174000");
    harness.setSnapshot(snapshot({ reference: anotherReference }));
    await expect(harness.coordinator.handlePopup({ kind: "get-tab-state", requestId: "stale" })).resolves.toMatchObject({ value: { diagnostic: null } });
    await harness.coordinator.handleContent({ kind: "image-load-failed", url: pageUrl, referenceId: imported.metadata.id }, { tabId: 9, frameId: 0, url: pageUrl });
    await expect(harness.coordinator.handlePopup({ kind: "get-tab-state", requestId: "mismatch" })).resolves.toMatchObject({ value: { diagnostic: null } });
  });

  it("ignores content events from other frames, URLs, and navigated tabs", async () => {
    const harness = createCoordinator();
    await harness.coordinator.handleContent({ kind: "placement-committed", url: pageUrl, placement: { x: 4, y: 5 } }, { tabId: 9, frameId: 1, url: pageUrl });
    await harness.coordinator.handleContent({ kind: "placement-committed", url: pageUrl, placement: { x: 4, y: 5 } }, { tabId: 9, frameId: 0, url: otherPageUrl });
    harness.tabs.tabs.set(9, { id: 9, url: otherPageUrl });
    await harness.coordinator.handleContent({ kind: "placement-committed", url: pageUrl, placement: { x: 4, y: 5 } }, { tabId: 9, frameId: 0, url: pageUrl });
    expect(harness.repository.updatePlacement).not.toHaveBeenCalled();
    expect(harness.siteAccess.has).not.toHaveBeenCalled();
  });
});
