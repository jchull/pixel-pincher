import { defineContentScript } from "wxt/utils/define-content-script";

import {
  ControlPanel,
  createContentImporter,
} from "../src/content/control-panel";
import { OverlayController } from "../src/content/overlay-controller";
import type { ContentEvent } from "../src/shared/contracts";
import { parseContentRequestWithPanelPosition } from "../src/shared/panel-position";

const controllerKey = Symbol.for("pixel-pincher.overlay-controller");
const panelKey = Symbol.for("pixel-pincher.control-panel");

type ContentWindow = Window & {
  [controllerKey]?: OverlayController;
  [panelKey]?: ControlPanel;
};

export function startOverlayContent(
  contentWindow: ContentWindow = window,
): OverlayController {
  const existing = contentWindow[controllerKey];
  if (existing !== undefined) return existing;

  const send = (event: ContentEvent): void => {
    void chrome.runtime.sendMessage(event).catch(() => undefined);
  };
  const panel = new ControlPanel({
    window: contentWindow,
    document: contentWindow.document,
    importReference: createContentImporter(),
    request(request) {
      return chrome.runtime.sendMessage(request);
    },
  });
  const controller = new OverlayController({
    window: contentWindow,
    document: contentWindow.document,
    requestAnimationFrame:
      contentWindow.requestAnimationFrame.bind(contentWindow),
    cancelAnimationFrame:
      contentWindow.cancelAnimationFrame.bind(contentWindow),
    onPlacementChanged: (placement) => panel.updatePlacement(placement),
    onPlacementCommitted: (placement) =>
      send({
        kind: "placement-committed",
        url: contentWindow.location.href,
        placement,
      }),
    onImageLoadFailed: (referenceId) =>
      send({
        kind: "image-load-failed",
        url: contentWindow.location.href,
        referenceId,
      }),
  });
  contentWindow[controllerKey] = controller;
  contentWindow[panelKey] = panel;
  chrome.runtime.onMessage.addListener((message: unknown) => {
    const request = parseContentRequestWithPanelPosition(message);
    if (!request.ok) return;
    switch (request.value.kind) {
      case "hydrate-overlay":
        void controller.hydrate(request.value.hydration);
        panel.hydrate(request.value.hydration);
        return;
      case "apply-settings":
        controller.apply(request.value.snapshot);
        panel.apply(request.value.snapshot);
        return;
      case "clear-overlay":
        controller.clear(request.value.revision);
        panel.clear(request.value.revision);
    }
  });
  send({ kind: "content-ready", url: contentWindow.location.href });
  return controller;
}

export default defineContentScript({
  allFrames: false,
  registration: "runtime",
  runAt: "document_idle",
  main() {
    startOverlayContent();
  },
});
