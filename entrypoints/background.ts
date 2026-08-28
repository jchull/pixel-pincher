import { defineBackground } from "wxt/utils/define-background";

import { OverlayRepository } from "../src/background/repository";
import { createChromeStorageAdapter } from "../src/background/storage-adapter";
import { createChromeSiteAccessAdapter, SiteAccessService } from "../src/background/site-access";

export default defineBackground(() => {
  const repository = new OverlayRepository(createChromeStorageAdapter());
  const siteAccess = new SiteAccessService(createChromeSiteAccessAdapter(), repository);

  const reconcile = (): void => {
    void siteAccess.reconcile();
  };

  chrome.runtime.onStartup.addListener(reconcile);
  chrome.runtime.onInstalled.addListener(reconcile);
  chrome.permissions.onRemoved.addListener(reconcile);
});
