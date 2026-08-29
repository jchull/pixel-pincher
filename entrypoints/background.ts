import { defineBackground } from "wxt/utils/define-background";

import { BackgroundCoordinator, createChromeTabResolver, type ContentSender } from "../src/background/coordinator";
import { handleCommand, isPixelPincherCommand } from "../src/background/commands";
import { handleTopFrameNavigation } from "../src/background/navigation";
import { OverlayRepository } from "../src/background/repository";
import { createChromeSiteAccessAdapter, originFromMatch, SiteAccessService } from "../src/background/site-access";
import { createChromeStorageAdapter } from "../src/background/storage-adapter";
import { createChromeTabMessageAdapter, sameCanonicalPage, TabMessenger } from "../src/background/tab-messenger";
import { AppError, type DeliveryError, publicError, type Result } from "../src/shared/contracts";
import { parseContentEvent, parsePopupRequest } from "../src/shared/parse";
import { parseContentPanelRequest } from "../src/shared/panel-position";

function contentSenderFrom(sender: chrome.runtime.MessageSender): ContentSender | undefined {
  const tabId = sender.tab?.id;
  const frameId = sender.frameId;
  if (tabId === undefined || frameId === undefined || sender.url === undefined) return undefined;
  return { tabId, frameId, url: sender.url };
}

function isPopupSender(sender: chrome.runtime.MessageSender): boolean {
  return sender.tab === undefined && sender.id === chrome.runtime.id;
}

export default defineBackground(() => {
  const repository = new OverlayRepository(createChromeStorageAdapter());
  const siteAccess = new SiteAccessService(createChromeSiteAccessAdapter(), repository);
  const tabs = createChromeTabResolver();
  const messenger = new TabMessenger(createChromeTabMessageAdapter(), {
    async inject(tabId, expectedUrl): Promise<Result<void, DeliveryError>> {
      const tab = await tabs.getTab(tabId);
      if (tab === null || !sameCanonicalPage(tab.url, expectedUrl.toString())) {
        return { ok: false, error: new AppError("content-unavailable") };
      }
      const injected = await siteAccess.injectForUrl(expectedUrl, tabId);
      return injected.ok
        ? { ok: true, value: undefined }
        : { ok: false, error: new AppError("content-unavailable", { cause: injected.error }) };
    },
  }, tabs);
  const coordinator = new BackgroundCoordinator({ repository, siteAccess, tabs, messenger });

  const startup = (): void => {
    void coordinator.startup();
  };

  chrome.runtime.onStartup.addListener(startup);
  chrome.runtime.onInstalled.addListener(startup);
  chrome.commands.onCommand.addListener((command) => {
    if (isPixelPincherCommand(command)) void handleCommand(coordinator, command);
  });
  chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
    void handleTopFrameNavigation(coordinator, { tabId: details.tabId, frameId: details.frameId, url: details.url });
  });
  chrome.permissions.onRemoved.addListener((permissions) => {
    const removedOrigins = (permissions.origins ?? []).flatMap((match) => {
      const origin = originFromMatch(match);
      return origin === undefined ? [] : [origin];
    });
    void coordinator.handlePermissionsRemoved(removedOrigins);
  });
  chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    if (sender.tab !== undefined) {
      const contentSender = contentSenderFrom(sender);
      if (contentSender === undefined) {
        sendResponse({ requestId: "invalid", ok: false, error: publicError("invalid-request") });
        return undefined;
      }
      const event = parseContentEvent(message);
      if (event.ok) {
        void coordinator.handleContent(event.value, contentSender);
        return undefined;
      }
      const panelRequest = parseContentPanelRequest(message);
      if (panelRequest.ok) {
        void coordinator.handlePanelRequest(panelRequest.value, contentSender)
          .then(sendResponse)
          .catch(() => sendResponse({ requestId: panelRequest.value.requestId, ok: false, error: publicError("storage-failed") }));
        return true;
      }
      sendResponse({ requestId: "invalid", ok: false, error: publicError("invalid-request") });
      return undefined;
    }

    if (!isPopupSender(sender)) {
      sendResponse({ requestId: "invalid", ok: false, error: publicError("invalid-request") });
      return undefined;
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
