import {
  AppError,
  type ContentEvent,
  type DeliveryError,
  type Hydration,
  type OverlaySnapshot,
  type PopupRequest,
  type PopupResponse,
  type RenderDiagnostic,
  type Result,
  type TabState,
  toPublicError,
} from "../shared/contracts";
import { deriveOrigin } from "../shared/keys";
import { parseSupportedUrl } from "../shared/parse";
import type { OverlayRepository } from "./repository";
import type { SiteAccessService } from "./site-access";
import { TabMessenger } from "./tab-messenger";

export type ActiveTab = Readonly<{ id: number; url: string }>;
export type ContentSender = Readonly<{ tabId: number; frameId: number; url: string }>;

type Repository = Pick<OverlayRepository,
  "cleanupOrphans" | "clearOrigin" | "readHydration" | "readSnapshot" | "replaceReference" | "updatePlacement" | "updateSettings">;
type SiteAccess = Pick<SiteAccessService, "ensureForUrl" | "has" | "injectForUrl" | "reconcile" | "unregisterOrigin">;

export interface TabResolver {
  getActiveTab(): Promise<ActiveTab | null>;
  getTab(tabId: number): Promise<ActiveTab | null>;
}


function failure<T>(requestId: string, error: AppError): PopupResponse<T> {
  return { requestId, ok: false, error: toPublicError(error) };
}

function success<T>(requestId: string, value: T): PopupResponse<T> {
  return { requestId, ok: true, value };
}

function deliveryFailure(result: Result<void, DeliveryError>): AppError {
  return result.ok ? new AppError("content-unavailable") : result.error;
}

/** Serializes tab actions and keeps diagnostic/delivery state intentionally in service-worker memory. */
export class BackgroundCoordinator {
  readonly #repository: Repository;
  readonly #siteAccess: SiteAccess;
  readonly #tabs: TabResolver;
  readonly #messenger: TabMessenger;
  readonly #tabOperations = new Map<number, Promise<void>>();
  readonly #deliveredRevision = new Map<number, number>();
  readonly #diagnostics = new Map<number, RenderDiagnostic>();

  constructor(options: Readonly<{ repository: Repository; siteAccess: SiteAccess; tabs: TabResolver; messenger: TabMessenger }>) {
    this.#repository = options.repository;
    this.#siteAccess = options.siteAccess;
    this.#tabs = options.tabs;
    this.#messenger = options.messenger;
  }

  async startup(): Promise<void> {
    await this.#repository.cleanupOrphans();
    await this.#siteAccess.reconcile();
  }

  async handlePopup(request: PopupRequest): Promise<PopupResponse<TabState | OverlaySnapshot | undefined>> {
    const active = await this.#tabs.getActiveTab();
    if (active === null) return failure(request.requestId, new AppError("unsupported-url"));
    return this.#runTab(active.id, async () => this.#handlePopupForActive(request, active));
  }

  async handleContent(event: ContentEvent, sender: ContentSender): Promise<void> {
    if (sender.frameId !== 0 || sender.url !== event.url) return;
    const parsed = parseSupportedUrl(event.url);
    if (!parsed.ok) return;
    const active = await this.#tabs.getTab(sender.tabId);
    if (active === null || active.url !== event.url) return;

    await this.#runTab(sender.tabId, async () => {
      switch (event.kind) {
        case "content-ready": {
          const hydration = await this.#repository.readHydration(parsed.value);
          if (!hydration.ok) return;
          await this.#deliverHydration(sender.tabId, hydration.value);
          return;
        }
        case "placement-committed": {
          const updated = await this.#repository.updatePlacement({ url: parsed.value, placement: event.placement });
          if (!updated.ok) return;
          await this.#deliverSettings(sender.tabId, updated.value);
          return;
        }
        case "image-load-failed":
          this.#diagnostics.set(sender.tabId, { referenceId: event.referenceId, error: toPublicError(new AppError("image-render-failed")) });
          return;
      }
    });
  }

  async #handlePopupForActive(request: PopupRequest, active: ActiveTab): Promise<PopupResponse<TabState | OverlaySnapshot | undefined>> {
    const url = parseSupportedUrl(active.url);
    if (!url.ok) return failure(request.requestId, new AppError("unsupported-url"));

    const activeOrigin = deriveOrigin(url.value);
    if (activeOrigin === undefined) return failure(request.requestId, new AppError("unsupported-url"));

    if (request.kind === "get-tab-state") {
      const enabled = await this.#siteAccess.has(activeOrigin);
      if (!enabled.ok) return failure(request.requestId, enabled.error);
      const snapshot = await this.#repository.readSnapshot(url.value);
      if (!snapshot.ok) return failure(request.requestId, snapshot.error);
      const diagnostic = this.#diagnostics.get(active.id);
      const state: TabState = {
        tabId: active.id,
        url: active.url,
        origin: activeOrigin,
        enabled: enabled.value,
        snapshot: snapshot.value,
        diagnostic: diagnostic ?? null,
      };
      return success(request.requestId, state);
    }

    const requested = parseSupportedUrl(request.url);
    if (!requested.ok || requested.value.toString() !== active.url) return failure(request.requestId, new AppError("invalid-request"));
    const origin = deriveOrigin(requested.value);
    if (origin === undefined) return failure(request.requestId, new AppError("unsupported-url"));

    if (request.kind === "register-site") {
      const ensured = await this.#siteAccess.ensureForUrl(requested.value);
      if (!ensured.ok) return failure(request.requestId, ensured.error);
      if (!await this.#sameTab(active)) return failure(request.requestId, new AppError("invalid-request"));
      return success(request.requestId, undefined);
    }

    if (request.kind === "clear-site") {
      const cleared = await this.#repository.clearOrigin(origin);
      if (!cleared.ok) return failure(request.requestId, cleared.error);
      const unregistered = await this.#siteAccess.unregisterOrigin(origin);
      if (!unregistered.ok) return failure(request.requestId, unregistered.error);
      if (!await this.#sameTab(active)) return failure(request.requestId, new AppError("invalid-request"));
      const delivered = await this.#messenger.deliver(active.id, { kind: "clear-overlay", revision: 0 });
      if (!delivered.ok) return failure(request.requestId, deliveryFailure(delivered));
      this.#deliveredRevision.delete(active.id);
      this.#diagnostics.delete(active.id);
      return success(request.requestId, undefined);
    }

    if (request.kind === "replace-reference") {
      const replaced = await this.#repository.replaceReference({ url: requested.value, reference: request.reference });
      if (!replaced.ok) return failure(request.requestId, replaced.error);
      if (!await this.#sameTab(active)) return failure(request.requestId, new AppError("invalid-request"));
      const hydration = await this.#repository.readHydration(requested.value);
      if (!hydration.ok) return failure(request.requestId, hydration.error);
      const delivered = await this.#deliverHydration(active.id, hydration.value);
      if (!delivered.ok) return failure(request.requestId, deliveryFailure(delivered));
      return success(request.requestId, replaced.value);
    }

    const updated = await this.#repository.updateSettings({ url: requested.value, patch: request.patch });
    if (!updated.ok) return failure(request.requestId, updated.error);
    if (!await this.#sameTab(active)) return failure(request.requestId, new AppError("invalid-request"));
    const delivered = await this.#deliverSettings(active.id, updated.value);
    if (!delivered.ok) return failure(request.requestId, deliveryFailure(delivered));
    return success(request.requestId, updated.value);
  }

  async #deliverHydration(tabId: number, hydration: Hydration): Promise<Result<void, DeliveryError>> {
    const delivered = await this.#messenger.deliver(tabId, { kind: "hydrate-overlay", hydration });
    if (delivered.ok) this.#deliveredRevision.set(tabId, hydration.snapshot.revision);
    return delivered;
  }

  async #deliverSettings(tabId: number, snapshot: OverlaySnapshot): Promise<Result<void, DeliveryError>> {
    const latest = this.#deliveredRevision.get(tabId);
    if (latest !== undefined && snapshot.revision <= latest) return { ok: true, value: undefined };
    const delivered = await this.#messenger.deliver(tabId, { kind: "apply-settings", snapshot });
    if (delivered.ok) this.#deliveredRevision.set(tabId, snapshot.revision);
    return delivered;
  }

  async #sameTab(expected: ActiveTab): Promise<boolean> {
    const current = await this.#tabs.getTab(expected.id);
    return current !== null && current.url === expected.url;
  }

  async #runTab<T>(tabId: number, operation: () => Promise<T>): Promise<T> {
    const previous = this.#tabOperations.get(tabId) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.then(() => gate);
    this.#tabOperations.set(tabId, queued);
    await previous;
    try {
      return await operation();
    } finally {
      release?.();
      if (this.#tabOperations.get(tabId) === queued) this.#tabOperations.delete(tabId);
    }
  }
}

export function createChromeTabResolver(): TabResolver {
  return {
    async getActiveTab() {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tab = tabs[0];
      return tab?.id !== undefined && tab.url !== undefined ? { id: tab.id, url: tab.url } : null;
    },
    async getTab(tabId) {
      try {
        const tab = await chrome.tabs.get(tabId);
        return tab.id !== undefined && tab.url !== undefined ? { id: tab.id, url: tab.url } : null;
      } catch {
        return null;
      }
    },
  };
}
