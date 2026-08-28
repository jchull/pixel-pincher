export const RUNTIME_PROOF_HOST_ID = "pixel-pincher-runtime-proof";

const PROOF_IMAGE_DATA_URL =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='1' height='1'%3E%3C/svg%3E";

export function mountRuntimeProof(document: Document): HTMLElement {
  const existingHost = document.getElementById(RUNTIME_PROOF_HOST_ID);
  if (existingHost instanceof HTMLElement) {
    return existingHost;
  }

  const host = document.createElement("pixel-pincher-runtime-proof");
  host.id = RUNTIME_PROOF_HOST_ID;

  const shadowRoot = host.attachShadow({ mode: "open" });
  const image = document.createElement("img");
  image.alt = "";
  image.src = PROOF_IMAGE_DATA_URL;
  shadowRoot.append(image);

  document.documentElement.append(host);
  return host;
}
