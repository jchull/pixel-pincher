import {
  MAX_PLACEMENT,
  MAX_SCALE_PERCENT,
  MIN_PLACEMENT,
  MIN_SCALE_PERCENT,
  type ImportedReference,
  type OverlaySnapshot,
  type Placement,
  type PopupRequest,
  type PublicError,
  type SettingsPatch,
  type Sizing,
  type TabState,
} from "../shared/contracts";
import {
  parseOverlaySnapshot,
  parsePopupResponse,
  parseSupportedUrl,
} from "../shared/parse";
import { parseTabStateWithPanelPosition } from "../shared/panel-position";

export type PopupState =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "unsupported" }>
  | Readonly<{ kind: "access-required"; url: string; origin: string }>
  | Readonly<{ kind: "enabled-empty"; tab: TabState; confirmingClear: boolean }>
  | Readonly<{
      kind: "enabled-reference";
      tab: TabState;
      confirmingClear: boolean;
    }>
  | Readonly<{
      kind: "error";
      error: PublicError;
      recovery: Exclude<
        PopupState,
        { kind: "loading" | "unsupported" | "error" }
      >;
    }>;

export interface PopupRuntimeAdapter {
  getActiveUrl(): Promise<string | null>;
  requestOrigin(origin: string): Promise<boolean>;
  send(request: PopupRequest): Promise<unknown>;
}

export interface PopupView {
  render(state: PopupState): void;
  restoreFocus(controlId: string): void;
}

export interface PopupImporter {
  (
    file: File,
  ): Promise<
    | Readonly<{ ok: true; value: ImportedReference }>
    | Readonly<{ ok: false; error: PublicError }>
  >;
}

type StateWithTab = Extract<PopupState, { tab: TabState }>;
type RecoveryState = Extract<
  PopupState,
  { kind: "access-required" | "enabled-empty" | "enabled-reference" }
>;
type PendingSettings = Readonly<{ patch: SettingsPatch; focusId: string }>;
type SnapshotRequest =
  | Readonly<{ kind: "register-site"; url: string }>
  | Readonly<{
      kind: "replace-reference";
      url: string;
      reference: ImportedReference;
    }>
  | Readonly<{ kind: "update-settings"; url: string; patch: SettingsPatch }>;

const INVALID_RESPONSE: PublicError = {
  code: "invalid-request",
  message: "Pixel Pincher received an invalid request.",
};

function parseVoid(
  value: unknown,
):
  | Readonly<{ ok: true; value: undefined }>
  | Readonly<{ ok: false; error: PublicError }> {
  return value === undefined
    ? { ok: true, value: undefined }
    : { ok: false, error: INVALID_RESPONSE };
}

function clampScale(value: number): number {
  return Math.min(
    MAX_SCALE_PERCENT,
    Math.max(MIN_SCALE_PERCENT, Math.round(value)),
  );
}

function clampPlacement(value: number): number {
  return Math.min(MAX_PLACEMENT, Math.max(MIN_PLACEMENT, Math.round(value)));
}

function parseInteger(value: string): number | undefined {
  if (!/^-?\d+$/.test(value.trim())) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function isEnabled(state: PopupState): state is StateWithTab {
  return state.kind === "enabled-empty" || state.kind === "enabled-reference";
}

function recoveryFor(tab: TabState): RecoveryState {
  return tab.enabled
    ? tab.snapshot.reference === null
      ? { kind: "enabled-empty", tab, confirmingClear: false }
      : { kind: "enabled-reference", tab, confirmingClear: false }
    : { kind: "access-required", url: tab.url, origin: tab.origin };
}

/** State machine for the popup. Browser APIs are isolated behind PopupRuntimeAdapter. */
export class PopupController {
  readonly #adapter: PopupRuntimeAdapter;
  readonly #view: PopupView;
  readonly #importer: PopupImporter;
  #state: PopupState = { kind: "loading" };
  #nextRequest = 1;
  #activeSite: Readonly<{ url: string; origin: string }> | undefined;
  #settingsInFlight = false;
  #pendingSettings: PendingSettings[] = [];
  #sizingIntent: Sizing | undefined;
  #placementIntent: Placement | undefined;

  constructor(
    options: Readonly<{
      adapter: PopupRuntimeAdapter;
      view: PopupView;
      importer: PopupImporter;
    }>,
  ) {
    this.#adapter = options.adapter;
    this.#view = options.view;
    this.#importer = options.importer;
  }

  get state(): PopupState {
    return this.#state;
  }

  async start(): Promise<void> {
    this.#setState({ kind: "loading" });
    const url = await this.#adapter.getActiveUrl();
    const parsed =
      url === null ? { ok: false as const } : parseSupportedUrl(url);
    if (!parsed.ok) {
      this.#setState({ kind: "unsupported" });
      return;
    }
    this.#activeSite = {
      url: parsed.value.toString(),
      origin: parsed.value.origin,
    };
    await this.#load();
  }

  async retry(): Promise<void> {
    if (this.#state.kind !== "error") return;
    await this.#load();
  }

  /** Must be called directly by the click handler: requestOrigin is the first awaited operation. */
  async enable(focusId = "enable-site"): Promise<void> {
    const recovery = this.#recover();
    if (recovery.kind !== "access-required") return;
    const granted = await this.#adapter.requestOrigin(`${recovery.origin}/*`);
    if (!granted) {
      this.#fail(
        {
          code: "site-access-denied",
          message: "Pixel Pincher needs permission for this site.",
        },
        recovery,
      );
      return;
    }
    const response = await this.#sendSnapshot(
      { kind: "register-site", url: recovery.url },
      focusId,
    );
    if (response !== undefined) this.#applySnapshot(response, focusId);
  }

  async importFile(file: File, focusId = "reference-file"): Promise<void> {
    const recovery = this.#recover();
    if (recovery.kind === "access-required") {
      await this.enable(focusId);
      if (isEnabled(this.#recover())) await this.importFile(file, focusId);
      return;
    }
    if (!isEnabled(recovery)) return;
    let imported: Awaited<ReturnType<PopupImporter>>;
    try {
      imported = await this.#importer(file);
    } catch {
      this.#fail(
        {
          code: "image-decode-failed",
          message: "Pixel Pincher could not decode that image.",
        },
        recovery,
      );
      return;
    }
    if (!imported.ok) {
      this.#fail(imported.error, recovery);
      return;
    }
    const response = await this.#sendSnapshot(
      {
        kind: "replace-reference",
        url: recovery.tab.url,
        reference: imported.value,
      },
      focusId,
    );
    if (response !== undefined) this.#applySnapshot(response, focusId);
  }

  updateSettings(
    patch: SettingsPatch,
    focusId: string,
    coalesce = false,
  ): void {
    const recovery = this.#recover();
    if (!isEnabled(recovery) || recovery.tab.snapshot.reference === null)
      return;
    this.#clearError();
    const pending = { patch, focusId };
    if (this.#settingsInFlight) {
      // Range inputs only retain their most recent unsent value; discrete actions stay ordered.
      if (coalesce) {
        const existing = this.#pendingSettings.findIndex(
          (candidate) => candidate.patch.kind === patch.kind,
        );
        if (existing === -1) this.#pendingSettings.push(pending);
        else this.#pendingSettings[existing] = pending;
      } else this.#pendingSettings.push(pending);
      return;
    }
    void this.#dispatchSettings(pending);
  }

  setOpacity(percent: number, focusId = "opacity"): void {
    const bounded = Math.min(100, Math.max(0, Math.round(percent)));
    this.updateSettings(
      { kind: "opacity", opacity: bounded / 100 },
      focusId,
      true,
    );
  }

  setSizingPercent(percent: number, focusId = "scale"): void {
    if (this.#enabledTab() === undefined) return;
    const sizing: Sizing = { kind: "scale", percent: clampScale(percent) };
    this.#sizingIntent = sizing;
    this.updateSettings({ kind: "sizing", sizing }, focusId, true);
  }

  setFitWidth(checked: boolean, focusId = "fit-width"): void {
    const tab = this.#enabledTab();
    if (tab === undefined) return;
    const current = this.#intendedSizing(tab);
    const sizing: Sizing = checked
      ? {
          kind: "fit-width",
          lastScalePercent:
            current.kind === "fit-width"
              ? current.lastScalePercent
              : current.percent,
        }
      : {
          kind: "scale",
          percent:
            current.kind === "fit-width"
              ? current.lastScalePercent
              : current.percent,
        };
    this.#sizingIntent = sizing;
    this.updateSettings({ kind: "sizing", sizing }, focusId, true);
  }

  resetScale(): void {
    this.setSizingPercent(100, "reset-scale");
  }

  commitNumber(kind: "x" | "y" | "scale", raw: string, focusId: string): void {
    const value = parseInteger(raw);
    if (value === undefined) return;
    if (kind === "scale") this.setSizingPercent(value, focusId);
    else this.#commitPlacement(kind, clampPlacement(value), focusId);
  }

  stepNumber(
    kind: "x" | "y" | "scale",
    direction: -1 | 1,
    shifted: boolean,
    focusId: string,
  ): void {
    const step = shifted ? 10 : 1;
    const tab = this.#enabledTab();
    if (tab === undefined) return;
    if (kind === "scale")
      this.setSizingPercent(this.#manualScale(tab) + direction * step, focusId);
    else
      this.#commitPlacement(
        kind,
        this.#intendedPlacement(tab)[kind] + direction * step,
        focusId,
      );
  }

  toggleClearConfirmation(): void {
    const state = this.#recover();
    if (!isEnabled(state)) return;
    this.#clearError();
    this.#setState({ ...state, confirmingClear: !state.confirmingClear });
  }

  async clearSite(focusId = "clear-site"): Promise<void> {
    const state = this.#recover();
    const corruptDataClear =
      this.#state.kind === "error" &&
      this.#state.error.code === "invalid-stored-data" &&
      state.kind === "access-required";
    if (!isEnabled(state) && !corruptDataClear) return;
    if (isEnabled(state) && !state.confirmingClear) return;
    const url = isEnabled(state) ? state.tab.url : state.url;
    const response = await this.#sendVoid({ kind: "clear-site", url }, focusId);
    if (response) await this.#load();
  }

  #commitPlacement(kind: "x" | "y", value: number, focusId: string): void {
    const tab = this.#enabledTab();
    if (tab === undefined) return;
    const placement: Placement = {
      ...this.#intendedPlacement(tab),
      [kind]: value,
    };
    this.#placementIntent = placement;
    this.updateSettings({ kind: "placement", placement }, focusId);
  }

  #intendedSizing(tab: TabState): Sizing {
    return this.#sizingIntent ?? tab.snapshot.settings.sizing;
  }

  #intendedPlacement(tab: TabState): Placement {
    return this.#placementIntent ?? tab.snapshot.settings.placement;
  }

  #manualScale(tab: TabState): number {
    const sizing = this.#intendedSizing(tab);
    return sizing.kind === "fit-width"
      ? sizing.lastScalePercent
      : sizing.percent;
  }

  /** Intents only bridge the round-trip: a confirmed snapshot is the source of truth again. */
  #dropIntents(): void {
    this.#sizingIntent = undefined;
    this.#placementIntent = undefined;
  }

  async #dispatchSettings(pending: PendingSettings): Promise<void> {
    const tab = this.#enabledTab();
    if (tab === undefined) {
      this.#pendingSettings = [];
      return;
    }
    this.#settingsInFlight = true;
    const response = await this.#sendSnapshot(
      { kind: "update-settings", url: tab.url, patch: pending.patch },
      pending.focusId,
    );
    this.#settingsInFlight = false;
    if (response === undefined) {
      // A failed mutation stops the queue and drops queued mutations; the error
      // stays visible until the user takes a new action.
      this.#pendingSettings = [];
      return;
    }
    this.#applySnapshot(response, pending.focusId);
    const next = this.#pendingSettings.shift();
    if (next !== undefined) void this.#dispatchSettings(next);
  }

  async #load(): Promise<void> {
    const response = await this.#sendTab({ kind: "get-tab-state" }, "");
    if (response !== undefined) this.#applyTab(response);
  }

  #requestId(): string {
    return `popup-${this.#nextRequest++}`;
  }

  async #sendTab(
    request: Omit<
      Extract<PopupRequest, { kind: "get-tab-state" }>,
      "requestId"
    >,
    focusId: string,
  ): Promise<TabState | undefined> {
    const requestId = this.#requestId();
    try {
      const parsed = parsePopupResponse(
        await this.#adapter.send({ ...request, requestId }),
        parseTabStateWithPanelPosition,
      );
      if (!parsed.ok || parsed.value.requestId !== requestId)
        return this.#invalid(focusId);
      if (!parsed.value.ok)
        return this.#fail(parsed.value.error, this.#recover(), focusId);
      return parsed.value.value;
    } catch {
      return this.#invalid(focusId);
    }
  }

  async #sendSnapshot(
    request: SnapshotRequest,
    focusId: string,
  ): Promise<OverlaySnapshot | undefined> {
    const requestId = this.#requestId();
    try {
      const parsed = parsePopupResponse(
        await this.#adapter.send({ ...request, requestId }),
        parseOverlaySnapshot,
      );
      if (!parsed.ok || parsed.value.requestId !== requestId)
        return this.#invalid(focusId);
      if (!parsed.value.ok)
        return this.#fail(parsed.value.error, this.#recover(), focusId);
      return parsed.value.value;
    } catch {
      return this.#invalid(focusId);
    }
  }

  async #sendVoid(
    request: Omit<Extract<PopupRequest, { kind: "clear-site" }>, "requestId">,
    focusId: string,
  ): Promise<boolean> {
    const requestId = this.#requestId();
    try {
      const parsed = parsePopupResponse(
        await this.#adapter.send({ ...request, requestId }),
        parseVoid,
      );
      if (!parsed.ok || parsed.value.requestId !== requestId) {
        this.#invalid(focusId);
        return false;
      }
      if (!parsed.value.ok) {
        this.#fail(parsed.value.error, this.#recover(), focusId);
        return false;
      }
      this.#view.restoreFocus(focusId);
      return true;
    } catch {
      this.#invalid(focusId);
      return false;
    }
  }

  #applyTab(tab: TabState): void {
    this.#dropIntents();
    this.#setState(recoveryFor(tab));
  }

  #applySnapshot(snapshot: OverlaySnapshot, focusId: string): void {
    this.#dropIntents();
    const prior = this.#enabledTab();
    const current = this.#recover();
    if (prior !== undefined)
      this.#applyTab({ ...prior, enabled: true, snapshot, diagnostic: null });
    else if (current.kind === "access-required") {
      this.#applyTab({
        tabId: 0,
        url: current.url,
        origin: snapshot.origin,
        enabled: true,
        snapshot,
        diagnostic: null,
      });
    } else return;
    this.#view.restoreFocus(focusId);
  }

  #enabledTab(): TabState | undefined {
    const state = this.#recover();
    return isEnabled(state) ? state.tab : undefined;
  }

  #recover(): PopupState {
    return this.#state.kind === "error" ? this.#state.recovery : this.#state;
  }

  #clearError(): void {
    if (this.#state.kind === "error") this.#setState(this.#state.recovery);
  }

  #invalid(focusId: string): undefined {
    this.#fail(INVALID_RESPONSE, this.#recover(), focusId);
    return undefined;
  }

  #fail(error: PublicError, recovery: PopupState, focusId?: string): undefined {
    this.#dropIntents();
    if (
      recovery.kind === "loading" ||
      recovery.kind === "unsupported" ||
      recovery.kind === "error"
    ) {
      const site = this.#activeSite;
      this.#setState({
        kind: "error",
        error,
        recovery: {
          kind: "access-required",
          url: site?.url ?? "",
          origin: site?.origin ?? "",
        },
      });
    } else this.#setState({ kind: "error", error, recovery });
    if (focusId !== undefined) this.#view.restoreFocus(focusId);
    return undefined;
  }

  #setState(state: PopupState): void {
    this.#state = state;
    this.#view.render(state);
  }
}
