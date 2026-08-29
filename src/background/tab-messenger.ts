import { AppError, type ContentRequest, type DeliveryError, type Result } from "../shared/contracts";
import { derivePageKey } from "../shared/keys";
import { parseSupportedUrl } from "../shared/parse";

export type TabPage = Readonly<{ id: number; url: string }>;

export interface TabMessageAdapter {
  send(tabId: number, request: ContentRequest): Promise<void>;
}

export interface TabInjection {
  inject(tabId: number, expectedUrl: URL): Promise<Result<void, DeliveryError>>;
}

export interface TabPageResolver {
  getTab(tabId: number): Promise<TabPage | null>;
}

function isMissingReceiver(error: unknown): boolean {
  return error instanceof Error && /receiving end does not exist|could not establish connection/i.test(error.message);
}

export function sameCanonicalPage(left: string, right: string): boolean {
  const leftUrl = parseSupportedUrl(left);
  const rightUrl = parseSupportedUrl(right);
  return leftUrl.ok && rightUrl.ok && derivePageKey(leftUrl.value) === derivePageKey(rightUrl.value);
}

/** Delivers one typed message, retrying exactly once after same-page recovery. */
export class TabMessenger {
  readonly #adapter: TabMessageAdapter;
  readonly #injection: TabInjection;
  readonly #tabs: TabPageResolver;

  constructor(adapter: TabMessageAdapter, injection: TabInjection, tabs: TabPageResolver) {
    this.#adapter = adapter;
    this.#injection = injection;
    this.#tabs = tabs;
  }

  async deliver(tabId: number, expectedUrl: URL, request: ContentRequest): Promise<Result<void, DeliveryError>> {
    if (!await this.#isExpectedPage(tabId, expectedUrl)) return this.#unavailable();
    try {
      await this.#adapter.send(tabId, request);
      return { ok: true, value: undefined };
    } catch (error: unknown) {
      if (!isMissingReceiver(error)) return { ok: false, error: new AppError("content-unavailable", { cause: error }) };
    }

    // The original send can race a navigation. Check again immediately before
    // executing the script and again immediately before retrying the message.
    if (!await this.#isExpectedPage(tabId, expectedUrl)) return this.#unavailable();
    const injected = await this.#injection.inject(tabId, expectedUrl);
    if (!injected.ok) return injected;
    if (!await this.#isExpectedPage(tabId, expectedUrl)) return this.#unavailable();
    try {
      await this.#adapter.send(tabId, request);
      return { ok: true, value: undefined };
    } catch (error: unknown) {
      return { ok: false, error: new AppError("content-unavailable", { cause: error }) };
    }
  }

  async #isExpectedPage(tabId: number, expectedUrl: URL): Promise<boolean> {
    const current = await this.#tabs.getTab(tabId);
    return current !== null && sameCanonicalPage(current.url, expectedUrl.toString());
  }

  #unavailable(): Result<void, DeliveryError> {
    return { ok: false, error: new AppError("content-unavailable") };
  }
}

export function createChromeTabMessageAdapter(): TabMessageAdapter {
  return {
    async send(tabId, request) {
      await chrome.tabs.sendMessage(tabId, request, { frameId: 0 });
    },
  };
}
