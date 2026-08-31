import {
  AppError,
  type ContentEvent,
  type ContentPanelRequest,
  type ContentPanelResponse,
  type DeliveryError,
  type Hydration,
  type OverlaySnapshot,
  type PopupRequest,
  type PopupResponse,
  type RenderDiagnostic,
  type ReferenceMetadata,
  type Result,
  type SettingsPatch,
  type TabState,
  toPublicError,
} from "../shared/contracts";
import { deriveOrigin, derivePageKey } from "../shared/keys";
import { parseOrigin, parseSupportedUrl } from "../shared/parse";
import type { OverlayRepository } from "./repository";
import { originFromMatch, type SiteAccessService } from "./site-access";
import { sameCanonicalPage, TabMessenger, type TabPage } from "./tab-messenger";
import type { PixelPincherCommand } from "./commands";
import type { TopFrameNavigation } from "./navigation";

export type ActiveTab = TabPage;
export type ContentSender = Readonly<{
  tabId: number;
  frameId: number;
  url: string;
}>;

type Repository = Pick<
  OverlayRepository,
  | "cleanupOrphans"
  | "purgeOrigin"
  | "readHydration"
  | "readSnapshot"
  | "replaceReference"
  | "updatePanelPosition"
  | "updatePlacement"
  | "updateSettings"
>;

type DeliveryState = Readonly<{
  pageKey: string;
  revision: number;
  referenceId: ReferenceMetadata["id"] | null;
}>;
type SiteAccess = Pick<
  SiteAccessService,
  "ensureForUrl" | "has" | "injectForUrl" | "reconcile" | "unregisterOrigin"
>;

export interface TabResolver {
  getActiveTab(): Promise<ActiveTab | null>;
  getTab(tabId: number): Promise<ActiveTab | null>;
  getTabs(): Promise<readonly ActiveTab[]>;
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

function nextRevision(revision: number): number | undefined {
  return revision < Number.MAX_SAFE_INTEGER ? revision + 1 : undefined;
}

/** Serializes tab actions and keeps diagnostic/delivery state intentionally in service-worker memory. */
export class BackgroundCoordinator {
  readonly #repository: Repository;
  readonly #siteAccess: SiteAccess;
  readonly #tabs: TabResolver;
  readonly #messenger: TabMessenger;
  readonly #tabOperations = new Map<number, Promise<void>>();
  readonly #deliveredState = new Map<number, DeliveryState>();
  readonly #diagnostics = new Map<number, RenderDiagnostic>();

  constructor(
    options: Readonly<{
      repository: Repository;
      siteAccess: SiteAccess;
      tabs: TabResolver;
      messenger: TabMessenger;
    }>,
  ) {
    this.#repository = options.repository;
    this.#siteAccess = options.siteAccess;
    this.#tabs = options.tabs;
    this.#messenger = options.messenger;
  }

  async startup(): Promise<void> {
    // Cleanup and reconciliation are independent repair paths: a failure in one
    // must never prevent attempting the other.
    await Promise.all([
      this.#repository.cleanupOrphans().catch(() => undefined),
      this.#siteAccess.reconcile().catch(() => undefined),
    ]);
  }

  async handleCommand(command: PixelPincherCommand): Promise<void> {
    const active = await this.#tabs.getActiveTab();
    if (active === null) return;
    await this.#runTab(active.id, async () =>
      this.#handleCommandForActive(command, active),
    );
  }

  async handleNavigation(navigation: TopFrameNavigation): Promise<void> {
    if (navigation.frameId !== 0) return;
    const parsed = parseSupportedUrl(navigation.url);
    if (!parsed.ok) return;
    await this.#runTab(navigation.tabId, async () => {
      if (!(await this.#sameTabPage(navigation.tabId, navigation.url))) return;
      const origin = deriveOrigin(parsed.value);
      if (origin === undefined) return;
      const enabled = await this.#siteAccess.has(origin);
      if (
        !enabled.ok ||
        !enabled.value ||
        !(await this.#sameTabPage(navigation.tabId, navigation.url))
      )
        return;
      const current = await this.#repository.readSnapshot(parsed.value);
      if (
        !current.ok ||
        !(await this.#sameTabPage(navigation.tabId, navigation.url))
      )
        return;
      this.#discardStaleDiagnostic(navigation.tabId, current.value);
      const delivered = this.#deliveredState.get(navigation.tabId);
      if (delivered?.referenceId === current.value.reference?.id) {
        await this.#deliverSettings(
          navigation.tabId,
          parsed.value,
          current.value,
        );
        return;
      }
      const hydration = await this.#repository.readHydration(parsed.value);
      if (
        !hydration.ok ||
        !(await this.#sameTabPage(navigation.tabId, navigation.url))
      )
        return;
      await this.#deliverHydration(
        navigation.tabId,
        parsed.value,
        hydration.value,
      );
    });
  }

  async handlePermissionsRemoved(origins: readonly string[]): Promise<void> {
    const removed = new Set(
      origins.flatMap((match) => {
        const matchedOrigin = originFromMatch(match);
        if (matchedOrigin !== undefined) return [matchedOrigin];
        const directOrigin = parseOrigin(match);
        return directOrigin.ok ? [directOrigin.value] : [];
      }),
    );
    if (removed.size > 0) {
      try {
        const tabs = await this.#tabs.getTabs();
        await Promise.all(
          tabs.map(async (tab) => {
            const parsed = parseSupportedUrl(tab.url);
            if (!parsed.ok) return undefined;
            const origin = deriveOrigin(parsed.value);
            if (origin === undefined || !removed.has(origin)) return undefined;
            await this.#runTab(tab.id, async () =>
              this.#clearRemovedTab(tab, parsed.value),
            );
            return undefined;
          }),
        );
      } catch {
        // Permission removal cleanup is best effort; reconciliation still runs.
      }
    }
    // The permission event supplies an exact origin even when its index is corrupt,
    // so deletion must not depend on startup reconciliation discovering it.
    await Promise.all(
      [...removed].map((origin) =>
        this.#repository.purgeOrigin(origin).catch(() => undefined),
      ),
    );
    await this.startup();
  }

  async handlePopup(
    request: PopupRequest,
  ): Promise<PopupResponse<TabState | OverlaySnapshot | undefined>> {
    const active = await this.#tabs.getActiveTab();
    if (active === null)
      return failure(request.requestId, new AppError("unsupported-url"));
    return this.#runTab(active.id, async () =>
      this.#handlePopupForActive(request, active),
    );
  }

  /** Handles uncorrelated lifecycle and overlay events from content scripts. */
  async handleContent(
    event: ContentEvent,
    sender: ContentSender,
  ): Promise<void> {
    if (sender.frameId !== 0 || sender.url !== event.url) return;
    const parsed = parseSupportedUrl(event.url);
    if (!parsed.ok) return;
    const origin = deriveOrigin(parsed.value);
    if (origin === undefined) return;
    const current = await this.#tabs.getTab(sender.tabId);
    if (current === null || !sameCanonicalPage(current.url, event.url)) return;

    await this.#runTab(sender.tabId, async () => {
      if (!(await this.#sameTabPage(sender.tabId, event.url))) return;

      switch (event.kind) {
        case "content-ready": {
          const hydration = await this.#repository.readHydration(parsed.value);
          if (
            !hydration.ok ||
            !(await this.#sameTabPage(sender.tabId, event.url))
          )
            return;
          const enabled = await this.#siteAccess.has(origin);
          if (!enabled.ok || !enabled.value) return;
          this.#discardStaleDiagnostic(sender.tabId, hydration.value.snapshot);
          await this.#deliverHydration(
            sender.tabId,
            parsed.value,
            hydration.value,
          );
          return;
        }
        case "placement-committed": {
          const enabled = await this.#siteAccess.has(origin);
          if (
            !enabled.ok ||
            !enabled.value ||
            !(await this.#sameTabPage(sender.tabId, event.url))
          )
            return;
          const updated = await this.#repository.updatePlacement({
            url: parsed.value,
            placement: event.placement,
          });
          if (
            !updated.ok ||
            !(await this.#sameTabPage(sender.tabId, event.url))
          )
            return;
          this.#discardStaleDiagnostic(sender.tabId, updated.value);
          await this.#deliverSettings(
            sender.tabId,
            parsed.value,
            updated.value,
          );
          return;
        }
        case "image-load-failed": {
          const snapshot = await this.#repository.readSnapshot(parsed.value);
          if (
            !snapshot.ok ||
            !(await this.#sameTabPage(sender.tabId, event.url))
          )
            return;
          const enabled = await this.#siteAccess.has(origin);
          if (!enabled.ok || !enabled.value) return;
          if (snapshot.value.reference?.id === event.referenceId) {
            this.#diagnostics.set(sender.tabId, {
              referenceId: event.referenceId,
              error: toPublicError(new AppError("image-render-failed")),
            });
          } else {
            this.#discardStaleDiagnostic(sender.tabId, snapshot.value);
          }
          return;
        }
      }
    });
  }

  /**
   * Mutates the panel position using only the top-frame sender URL, never a URL supplied by content.
   * The returned request ID lets a future panel discard stale asynchronous responses.
   */
  async handlePanelRequest(
    request: ContentPanelRequest,
    sender: ContentSender,
  ): Promise<ContentPanelResponse<OverlaySnapshot | undefined>> {
    if (sender.frameId !== 0)
      return failure(request.requestId, new AppError("invalid-request"));
    const url = parseSupportedUrl(sender.url);
    if (!url.ok)
      return failure(request.requestId, new AppError("invalid-request"));
    const origin = deriveOrigin(url.value);
    if (origin === undefined)
      return failure(request.requestId, new AppError("unsupported-url"));

    return this.#runTab(sender.tabId, async () => {
      if (!(await this.#sameTabPage(sender.tabId, sender.url))) {
        return failure(request.requestId, new AppError("invalid-request"));
      }
      const enabled = await this.#siteAccess.has(origin);
      if (!enabled.ok) return failure(request.requestId, enabled.error);
      if (!enabled.value)
        return failure(request.requestId, new AppError("site-access-revoked"));
      if (!(await this.#sameTabPage(sender.tabId, sender.url))) {
        return failure(request.requestId, new AppError("invalid-request"));
      }
      switch (request.kind) {
        case "get-panel-state": {
          const snapshot = await this.#repository.readSnapshot(url.value);
          if (!snapshot.ok) return failure(request.requestId, snapshot.error);
          return (await this.#sameTabPage(sender.tabId, sender.url))
            ? success(request.requestId, snapshot.value)
            : failure(request.requestId, new AppError("invalid-request"));
        }
        case "update-panel-position": {
          const updated = await this.#repository.updatePanelPosition({
            url: url.value,
            panelPosition: request.panelPosition,
          });
          if (!updated.ok) return failure(request.requestId, updated.error);
          return (await this.#sameTabPage(sender.tabId, sender.url))
            ? success(request.requestId, updated.value)
            : failure(request.requestId, new AppError("invalid-request"));
        }
        case "replace-reference": {
          const replaced = await this.#repository.replaceReference({
            url: url.value,
            reference: request.reference,
          });
          if (!replaced.ok) return failure(request.requestId, replaced.error);
          const hydration = await this.#repository.readHydration(url.value);
          if (!hydration.ok) return failure(request.requestId, hydration.error);
          if (!(await this.#sameTabPage(sender.tabId, sender.url))) {
            return failure(request.requestId, new AppError("invalid-request"));
          }
          const delivered = await this.#deliverHydration(
            sender.tabId,
            url.value,
            hydration.value,
          );
          return delivered.ok
            ? success(request.requestId, replaced.value)
            : failure(request.requestId, deliveryFailure(delivered));
        }
        case "update-settings": {
          const updated = await this.#repository.updateSettings({
            url: url.value,
            patch: request.patch,
          });
          if (!updated.ok) return failure(request.requestId, updated.error);
          this.#discardStaleDiagnostic(sender.tabId, updated.value);
          if (!(await this.#sameTabPage(sender.tabId, sender.url))) {
            return failure(request.requestId, new AppError("invalid-request"));
          }
          const delivered = await this.#deliverSettings(
            sender.tabId,
            url.value,
            updated.value,
          );
          return delivered.ok
            ? success(request.requestId, updated.value)
            : failure(request.requestId, deliveryFailure(delivered));
        }
        case "clear-site": {
          const snapshot = await this.#repository.readSnapshot(url.value);
          if (!snapshot.ok) return failure(request.requestId, snapshot.error);
          const revision = nextRevision(
            Math.max(
              snapshot.value.revision,
              this.#deliveredRevisionFor(sender.tabId, url.value),
            ),
          );
          if (revision === undefined)
            return failure(
              request.requestId,
              new AppError("invalid-stored-data"),
            );
          const cleared = await this.#repository.purgeOrigin(origin);
          if (!cleared.ok) return failure(request.requestId, cleared.error);
          const unregistered = await this.#siteAccess.unregisterOrigin(origin);
          if (!unregistered.ok)
            return failure(request.requestId, unregistered.error);
          if (!(await this.#sameTabPage(sender.tabId, sender.url))) {
            return failure(request.requestId, new AppError("invalid-request"));
          }
          const delivered = await this.#messenger.deliver(
            sender.tabId,
            url.value,
            { kind: "clear-overlay", revision },
          );
          if (!delivered.ok)
            return failure(request.requestId, deliveryFailure(delivered));
          this.#diagnostics.delete(sender.tabId);
          this.#rememberDelivery(sender.tabId, url.value, revision);
          return success(request.requestId, undefined);
        }
      }
    });
  }

  async #handlePopupForActive(
    request: PopupRequest,
    active: ActiveTab,
  ): Promise<PopupResponse<TabState | OverlaySnapshot | undefined>> {
    const url = parseSupportedUrl(active.url);
    if (!url.ok)
      return failure(request.requestId, new AppError("unsupported-url"));

    const activeOrigin = deriveOrigin(url.value);
    if (activeOrigin === undefined)
      return failure(request.requestId, new AppError("unsupported-url"));

    if (request.kind === "get-tab-state") {
      const enabled = await this.#siteAccess.has(activeOrigin);
      if (!enabled.ok) return failure(request.requestId, enabled.error);
      if (enabled.value) {
        if (!(await this.#sameActiveTab(active)))
          return failure(request.requestId, new AppError("invalid-request"));
        const injected = await this.#siteAccess.injectForUrl(
          url.value,
          active.id,
        );
        if (!injected.ok) return failure(request.requestId, injected.error);
      }
      const snapshot = await this.#repository.readSnapshot(url.value);
      if (!snapshot.ok) return failure(request.requestId, snapshot.error);
      if (!(await this.#sameActiveTab(active)))
        return failure(request.requestId, new AppError("invalid-request"));
      const diagnostic = this.#diagnosticFor(active.id, snapshot.value);
      const state: TabState = {
        tabId: active.id,
        url: active.url,
        origin: activeOrigin,
        enabled: enabled.value,
        snapshot: snapshot.value,
        diagnostic,
      };
      return success(request.requestId, state);
    }

    const requested = parseSupportedUrl(request.url);
    if (
      !requested.ok ||
      !sameCanonicalPage(requested.value.toString(), active.url)
    ) {
      return failure(request.requestId, new AppError("invalid-request"));
    }
    const origin = deriveOrigin(requested.value);
    if (origin === undefined)
      return failure(request.requestId, new AppError("unsupported-url"));

    if (request.kind === "register-site") {
      if (!(await this.#sameActiveTab(active)))
        return failure(request.requestId, new AppError("invalid-request"));
      const ensured = await this.#siteAccess.ensureForUrl(requested.value);
      if (!ensured.ok) return failure(request.requestId, ensured.error);
      if (!(await this.#sameActiveTab(active)))
        return failure(request.requestId, new AppError("invalid-request"));
      const injected = await this.#siteAccess.injectForUrl(
        requested.value,
        active.id,
      );
      if (!injected.ok) return failure(request.requestId, injected.error);
      if (!(await this.#sameActiveTab(active)))
        return failure(request.requestId, new AppError("invalid-request"));
      const hydration = await this.#repository.readHydration(requested.value);
      if (!hydration.ok) return failure(request.requestId, hydration.error);
      const delivered = await this.#deliverHydration(
        active.id,
        requested.value,
        hydration.value,
      );
      if (!delivered.ok)
        return failure(request.requestId, deliveryFailure(delivered));
      return success(request.requestId, hydration.value.snapshot);
    }

    if (request.kind === "clear-site") {
      const snapshot = await this.#repository.readSnapshot(requested.value);
      // Corrupt stored data cannot be read back, but the clear must still reach
      // the repository; fall back to the last delivered revision for the overlay message.
      let latest: number;
      if (snapshot.ok)
        latest = Math.max(
          snapshot.value.revision,
          this.#deliveredRevisionFor(active.id, requested.value),
        );
      else if (snapshot.error.code === "invalid-stored-data")
        latest = this.#deliveredRevisionFor(active.id, requested.value);
      else return failure(request.requestId, snapshot.error);
      const revision = nextRevision(latest);
      if (revision === undefined)
        return failure(request.requestId, new AppError("invalid-stored-data"));
      if (!(await this.#sameActiveTab(active)))
        return failure(request.requestId, new AppError("invalid-request"));
      const cleared = await this.#repository.purgeOrigin(origin);
      if (!cleared.ok) return failure(request.requestId, cleared.error);
      this.#diagnostics.delete(active.id);
      if (!(await this.#sameActiveTab(active)))
        return failure(request.requestId, new AppError("invalid-request"));
      const unregistered = await this.#siteAccess.unregisterOrigin(origin);
      if (!unregistered.ok)
        return failure(request.requestId, unregistered.error);
      if (!(await this.#sameActiveTab(active)))
        return failure(request.requestId, new AppError("invalid-request"));
      const delivered = await this.#messenger.deliver(
        active.id,
        requested.value,
        { kind: "clear-overlay", revision },
      );
      if (!delivered.ok)
        return failure(request.requestId, deliveryFailure(delivered));
      this.#rememberDelivery(active.id, requested.value, revision);
      if (!(await this.#sameActiveTab(active)))
        return failure(request.requestId, new AppError("invalid-request"));
      return success(request.requestId, undefined);
    }

    if (request.kind === "replace-reference") {
      if (!(await this.#sameActiveTab(active)))
        return failure(request.requestId, new AppError("invalid-request"));
      const enabled = await this.#siteAccess.has(origin);
      if (!enabled.ok) return failure(request.requestId, enabled.error);
      if (!enabled.value)
        return failure(request.requestId, new AppError("site-access-revoked"));
      if (!(await this.#sameActiveTab(active)))
        return failure(request.requestId, new AppError("invalid-request"));
      const replaced = await this.#repository.replaceReference({
        url: requested.value,
        reference: request.reference,
      });
      if (!replaced.ok) return failure(request.requestId, replaced.error);
      this.#discardStaleDiagnostic(active.id, replaced.value);
      if (!(await this.#sameActiveTab(active)))
        return failure(request.requestId, new AppError("invalid-request"));
      const hydration = await this.#repository.readHydration(requested.value);
      if (!hydration.ok) return failure(request.requestId, hydration.error);
      if (!(await this.#sameActiveTab(active)))
        return failure(request.requestId, new AppError("invalid-request"));
      const delivered = await this.#deliverHydration(
        active.id,
        requested.value,
        hydration.value,
      );
      if (!delivered.ok)
        return failure(request.requestId, deliveryFailure(delivered));
      if (!(await this.#sameActiveTab(active)))
        return failure(request.requestId, new AppError("invalid-request"));
      return success(request.requestId, replaced.value);
    }

    if (!(await this.#sameActiveTab(active)))
      return failure(request.requestId, new AppError("invalid-request"));
    const enabled = await this.#siteAccess.has(origin);
    if (!enabled.ok) return failure(request.requestId, enabled.error);
    if (!enabled.value)
      return failure(request.requestId, new AppError("site-access-revoked"));
    if (!(await this.#sameActiveTab(active)))
      return failure(request.requestId, new AppError("invalid-request"));
    const updated = await this.#repository.updateSettings({
      url: requested.value,
      patch: request.patch,
    });
    if (!updated.ok) return failure(request.requestId, updated.error);
    this.#discardStaleDiagnostic(active.id, updated.value);
    if (!(await this.#sameActiveTab(active)))
      return failure(request.requestId, new AppError("invalid-request"));
    const delivered = await this.#deliverSettings(
      active.id,
      requested.value,
      updated.value,
    );
    if (!delivered.ok)
      return failure(request.requestId, deliveryFailure(delivered));
    if (!(await this.#sameActiveTab(active)))
      return failure(request.requestId, new AppError("invalid-request"));
    return success(request.requestId, updated.value);
  }

  async #handleCommandForActive(
    command: PixelPincherCommand,
    active: ActiveTab,
  ): Promise<void> {
    const parsed = parseSupportedUrl(active.url);
    if (!parsed.ok) return;
    const origin = deriveOrigin(parsed.value);
    if (origin === undefined) return;
    const enabled = await this.#siteAccess.has(origin);
    if (!enabled.ok || !enabled.value || !(await this.#sameActiveTab(active)))
      return;
    const current = await this.#repository.readSnapshot(parsed.value);
    if (
      !current.ok ||
      current.value.reference === null ||
      !(await this.#sameActiveTab(active))
    )
      return;

    const patch = this.#commandPatch(command, current.value);
    if (patch === undefined) return;
    const updated = await this.#repository.updateSettings({
      url: parsed.value,
      patch,
    });
    if (!updated.ok || !(await this.#sameActiveTab(active))) return;
    this.#discardStaleDiagnostic(active.id, updated.value);
    await this.#deliverSettings(active.id, parsed.value, updated.value);
  }

  #commandPatch(
    command: PixelPincherCommand,
    snapshot: OverlaySnapshot,
  ): SettingsPatch | undefined {
    switch (command) {
      case "toggle-visibility":
        return { kind: "visibility", visible: !snapshot.settings.visible };
      case "nudge-left":
        return this.#nudge(snapshot, -1, 0);
      case "nudge-right":
        return this.#nudge(snapshot, 1, 0);
      case "nudge-up":
        return this.#nudge(snapshot, 0, -1);
      case "nudge-down":
        return this.#nudge(snapshot, 0, 1);
    }
  }

  #nudge(
    snapshot: OverlaySnapshot,
    x: number,
    y: number,
  ): SettingsPatch | undefined {
    const placement = {
      x: snapshot.settings.placement.x + x,
      y: snapshot.settings.placement.y + y,
    };
    if (
      !Number.isSafeInteger(placement.x) ||
      !Number.isSafeInteger(placement.y) ||
      placement.x < -1_000_000 ||
      placement.x > 1_000_000 ||
      placement.y < -1_000_000 ||
      placement.y > 1_000_000
    ) {
      return undefined;
    }
    return { kind: "placement", placement };
  }

  #diagnosticFor(
    tabId: number,
    snapshot: OverlaySnapshot,
  ): RenderDiagnostic | null {
    const diagnostic = this.#diagnostics.get(tabId);
    if (
      diagnostic !== undefined &&
      diagnostic.referenceId !== snapshot.reference?.id
    ) {
      this.#diagnostics.delete(tabId);
      return null;
    }
    return diagnostic ?? null;
  }

  #discardStaleDiagnostic(tabId: number, snapshot: OverlaySnapshot): void {
    this.#diagnosticFor(tabId, snapshot);
  }

  async #deliverHydration(
    tabId: number,
    expectedUrl: URL,
    hydration: Hydration,
  ): Promise<Result<void, DeliveryError>> {
    const delivered = await this.#messenger.deliver(tabId, expectedUrl, {
      kind: "hydrate-overlay",
      hydration,
    });
    if (delivered.ok)
      this.#rememberDelivery(
        tabId,
        expectedUrl,
        hydration.snapshot.revision,
        hydration.snapshot.reference?.id ?? null,
      );
    return delivered;
  }

  async #deliverSettings(
    tabId: number,
    expectedUrl: URL,
    snapshot: OverlaySnapshot,
  ): Promise<Result<void, DeliveryError>> {
    if (snapshot.revision <= this.#deliveredRevisionFor(tabId, expectedUrl))
      return { ok: true, value: undefined };
    const delivered = await this.#messenger.deliver(tabId, expectedUrl, {
      kind: "apply-settings",
      snapshot,
    });
    if (delivered.ok)
      this.#rememberDelivery(
        tabId,
        expectedUrl,
        snapshot.revision,
        snapshot.reference?.id ?? null,
      );
    return delivered;
  }

  #deliveredRevisionFor(tabId: number, expectedUrl: URL): number {
    const pageKey = derivePageKey(expectedUrl);
    const delivered = this.#deliveredState.get(tabId);
    return pageKey !== undefined && delivered?.pageKey === pageKey
      ? delivered.revision
      : 0;
  }

  #rememberDelivery(
    tabId: number,
    expectedUrl: URL,
    revision: number,
    referenceId: DeliveryState["referenceId"] = null,
  ): void {
    const pageKey = derivePageKey(expectedUrl);
    if (pageKey !== undefined)
      this.#deliveredState.set(tabId, { pageKey, revision, referenceId });
  }

  async #clearRemovedTab(tab: ActiveTab, expectedUrl: URL): Promise<void> {
    if (!(await this.#sameTabPage(tab.id, expectedUrl.toString()))) return;
    const snapshot = await this.#repository.readSnapshot(expectedUrl);
    if (
      !snapshot.ok ||
      !(await this.#sameTabPage(tab.id, expectedUrl.toString()))
    )
      return;
    const revision = nextRevision(
      Math.max(
        snapshot.value.revision,
        this.#deliveredRevisionFor(tab.id, expectedUrl),
      ),
    );
    if (revision === undefined) return;
    const delivered = await this.#messenger.deliver(tab.id, expectedUrl, {
      kind: "clear-overlay",
      revision,
    });
    if (delivered.ok) this.#rememberDelivery(tab.id, expectedUrl, revision);
  }

  async #sameActiveTab(expected: ActiveTab): Promise<boolean> {
    const current = await this.#tabs.getActiveTab();
    return (
      current !== null &&
      current.id === expected.id &&
      sameCanonicalPage(current.url, expected.url)
    );
  }

  async #sameTabPage(tabId: number, expectedUrl: string): Promise<boolean> {
    const current = await this.#tabs.getTab(tabId);
    return current !== null && sameCanonicalPage(current.url, expectedUrl);
  }

  async #runTab<T>(tabId: number, operation: () => Promise<T>): Promise<T> {
    const previous = this.#tabOperations.get(tabId) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => gate);
    this.#tabOperations.set(tabId, queued);
    await previous;
    try {
      return await operation();
    } finally {
      release?.();
      if (this.#tabOperations.get(tabId) === queued)
        this.#tabOperations.delete(tabId);
    }
  }
}

export function createChromeTabResolver(): TabResolver {
  return {
    async getActiveTab() {
      const tabs = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      const tab = tabs[0];
      return tab?.id !== undefined && tab.url !== undefined
        ? { id: tab.id, url: tab.url }
        : null;
    },
    async getTab(tabId) {
      try {
        const tab = await chrome.tabs.get(tabId);
        return tab.id !== undefined && tab.url !== undefined
          ? { id: tab.id, url: tab.url }
          : null;
      } catch {
        return null;
      }
    },
    async getTabs() {
      const tabs = await chrome.tabs.query({});
      return tabs.flatMap((tab) =>
        tab.id !== undefined && tab.url !== undefined
          ? [{ id: tab.id, url: tab.url }]
          : [],
      );
    },
  };
}
