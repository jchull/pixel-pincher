import type { PopupRequest, PublicError, TabState } from "../shared/contracts";
import { parsePopupResponse, parseSupportedUrl, parseTabState } from "../shared/parse";

export type PopupState =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "unsupported" }>
  | Readonly<{ kind: "access-required"; url: string; origin: string }>
  | Readonly<{ kind: "enabled"; url: string; origin: string }>
  | Readonly<{
      kind: "error";
      error: PublicError;
      recovery: Exclude<PopupState, { kind: "loading" | "unsupported" | "error" }>;
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

type RecoveryState = Extract<
  PopupState,
  { kind: "access-required" | "enabled" }
>;

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

function recoveryFor(tab: TabState): RecoveryState {
  return tab.enabled
    ? { kind: "enabled", url: tab.url, origin: tab.origin }
    : { kind: "access-required", url: tab.url, origin: tab.origin };
}

/** Popup state machine for access bootstrap, recovery, and panel visibility. */
export class PopupController {
  readonly #adapter: PopupRuntimeAdapter;
  readonly #view: PopupView;
  #state: PopupState = { kind: "loading" };
  #nextRequest = 1;
  #activeSite: Readonly<{ url: string; origin: string }> | undefined;

  constructor(options: Readonly<{ adapter: PopupRuntimeAdapter; view: PopupView }>) {
    this.#adapter = options.adapter;
    this.#view = options.view;
  }

  get state(): PopupState {
    return this.#state;
  }

  async start(): Promise<void> {
    this.#setState({ kind: "loading" });
    const url = await this.#adapter.getActiveUrl();
    const parsed = url === null ? { ok: false as const } : parseSupportedUrl(url);
    if (!parsed.ok) {
      this.#setState({ kind: "unsupported" });
      return;
    }
    this.#activeSite = { url: parsed.value.toString(), origin: parsed.value.origin };
    await this.#load();
  }

  async retry(): Promise<void> {
    if (this.#state.kind !== "error") return;
    await this.#load();
  }

  /** Must be called by the click handler: requesting permission is the first await. */
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
        focusId,
      );
      return;
    }
    if (await this.#sendVoid({ kind: "register-site", url: recovery.url }, focusId)) {
      this.#setState({ kind: "enabled", url: recovery.url, origin: recovery.origin });
    }
  }

  /** Clears corrupt data even when the current state could not be loaded. */
  async clearCorruptSite(focusId = "clear-corrupt-site"): Promise<void> {
    const recovery = this.#recover();
    const canClear =
      this.#state.kind === "error" &&
      this.#state.error.code === "invalid-stored-data" &&
      recovery.kind === "access-required";
    if (!canClear) return;
    if (await this.#sendVoid({ kind: "clear-site", url: recovery.url }, focusId))
      await this.#load();
  }

  async #load(): Promise<void> {
    const tab = await this.#sendTab({ kind: "get-tab-state" }, "");
    if (tab !== undefined) this.#setState(recoveryFor(tab));
  }

  #requestId(): string {
    return `popup-${this.#nextRequest++}`;
  }

  async #sendTab(
    request: Omit<Extract<PopupRequest, { kind: "get-tab-state" }>, "requestId">,
    focusId: string,
  ): Promise<TabState | undefined> {
    const requestId = this.#requestId();
    try {
      const parsed = parsePopupResponse(
        await this.#adapter.send({ ...request, requestId }),
        parseTabState,
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
    request: Omit<Exclude<PopupRequest, { kind: "get-tab-state" }>, "requestId">,
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

  #recover(): PopupState {
    return this.#state.kind === "error" ? this.#state.recovery : this.#state;
  }

  #invalid(focusId: string): undefined {
    return this.#fail(INVALID_RESPONSE, this.#recover(), focusId);
  }

  #fail(error: PublicError, recovery: PopupState, focusId?: string): undefined {
    const site = this.#activeSite;
    const fallback: RecoveryState = {
      kind: "access-required",
      url: site?.url ?? "",
      origin: site?.origin ?? "",
    };
    this.#setState({
      kind: "error",
      error,
      recovery:
        recovery.kind === "access-required" || recovery.kind === "enabled"
          ? recovery
          : fallback,
    });
    if (focusId !== undefined && focusId !== "")
      this.#view.restoreFocus(focusId);
    return undefined;
  }

  #setState(state: PopupState): void {
    this.#state = state;
    this.#view.render(state);
  }
}
