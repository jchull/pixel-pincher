import { AppError, type ContentRequest, type DeliveryError, type Result } from "../shared/contracts";

export interface TabMessageAdapter {
  send(tabId: number, request: ContentRequest): Promise<void>;
}

export interface TabInjection {
  inject(tabId: number): Promise<Result<void, DeliveryError>>;
}

function isMissingReceiver(error: unknown): boolean {
  return error instanceof Error && /receiving end does not exist|could not establish connection/i.test(error.message);
}

/** Delivers one typed message, retrying exactly once after same-tab recovery. */
export class TabMessenger {
  readonly #adapter: TabMessageAdapter;
  readonly #injection: TabInjection;

  constructor(adapter: TabMessageAdapter, injection: TabInjection) {
    this.#adapter = adapter;
    this.#injection = injection;
  }

  async deliver(tabId: number, request: ContentRequest): Promise<Result<void, DeliveryError>> {
    try {
      await this.#adapter.send(tabId, request);
      return { ok: true, value: undefined };
    } catch (error: unknown) {
      if (!isMissingReceiver(error)) return { ok: false, error: new AppError("content-unavailable", { cause: error }) };
    }

    const injected = await this.#injection.inject(tabId);
    if (!injected.ok) return injected;
    try {
      await this.#adapter.send(tabId, request);
      return { ok: true, value: undefined };
    } catch (error: unknown) {
      return { ok: false, error: new AppError("content-unavailable", { cause: error }) };
    }
  }
}

export function createChromeTabMessageAdapter(): TabMessageAdapter {
  return {
    async send(tabId, request) {
      await chrome.tabs.sendMessage(tabId, request, { frameId: 0 });
    },
  };
}
