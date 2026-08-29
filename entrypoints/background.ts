import { defineBackground } from "wxt/utils/define-background";

import { BackgroundCoordinator, createChromeTabResolver, type ContentSender } from "../src/background/coordinator";
import { OverlayRepository } from "../src/background/repository";
import { createChromeSiteAccessAdapter, SiteAccessService } from "../src/background/site-access";
import { createChromeStorageAdapter } from "../src/background/storage-adapter";
import { createChromeTabMessageAdapter, TabMessenger } from "../src/background/tab-messenger";
import { AppError, type DeliveryError, publicError, type Result } from "../src/shared/contracts";
import { parseContentEvent, parsePopupRequest } from "../src/shared/parse";

function contentSenderFrom(sender: chrome.runtime.MessageSender): ContentSender | undefined {
  const tabId = sender.tab?.id;
  const frameId = sender.frameId;
  if (tabId === undefined || frameId === undefined || sender.url === undefined) return undefined;
  return { tabId, frameId, url: sender.url };
}

export default defineBackground(() => {
  const repository = new OverlayRepository(createChromeStorageAdapter());
  const siteAccess = new SiteAccessService(createChromeSiteAccessAdapter(), repository);
  const tabs = createChromeTabResolver();
  const messenger = new TabMessenger(createChromeTabMessageAdapter(), {
    async inject(tabId): Promise<Result<void, DeliveryError>> {
      const tab = await tabs.getTab(tabId);
      if (tab === null) return { ok: false, error: new AppError("content-unavailable") };
      let url: URL;
      try {
        url = new URL(tab.url);
      } catch {
        return { ok: false, error: new AppError("content-unavailable") };
      }
      const injected = await siteAccess.injectForUrl(url, tabId);
      return injected.ok
        ? { ok: true, value: undefined }
        : { ok: false, error: new AppError("content-unavailable", { cause: injected.error }) };
    },
  });
  const coordinator = new BackgroundCoordinator({ repository, siteAccess, tabs, messenger });

  const startup = (): void => {
    void coordinator.startup();
  };

  chrome.runtime.onStartup.addListener(startup);
  chrome.runtime.onInstalled.addListener(startup);
  chrome.permissions.onRemoved.addListener(startup);
  chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    const contentSender = contentSenderFrom(sender);
    if (contentSender !== undefined) {
      const event = parseContentEvent(message);
      if (event.ok) {
        void coordinator.handleContent(event.value, contentSender);
        return undefined;
      }
    }

    const request = parsePopupRequest(message);
    if (!request.ok) {
      sendResponse({ requestId: "invalid", ok: false, error: publicError("invalid-request") });
      return undefined;
    }
    void coordinator.handlePopup(request.value)
      .then(sendResponse)
      .catch(() => sendResponse({ requestId: request.value.requestId, ok: false, error: publicError("content-unavailable") }));
    return true;
  });
});
