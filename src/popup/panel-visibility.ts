/**
 * Returns undefined when the current document has not received the runtime
 * content script yet. A missing host is not a visible panel.
 *
 * Keep this function self-contained: Chrome serializes executeScript functions
 * into the target document without their module bindings.
 */
export function readPanelVisibility(): boolean | undefined {
  const panel = document.getElementById("pixel-pincher-control-panel");
  return panel === null ? undefined : panel.style.display !== "none";
}

/** Shows or hides the existing in-page panel without changing overlay settings. */
export function setPanelVisibility(visible: boolean): boolean {
  const panel = document.getElementById("pixel-pincher-control-panel");
  if (panel === null) return false;
  panel.style.display = visible ? "block" : "none";
  panel.setAttribute("aria-hidden", String(!visible));
  return true;
}
