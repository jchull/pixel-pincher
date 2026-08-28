export const RUNTIME_PROOF_HOST_ID = "pixel-pincher-runtime-proof";

const PROOF_IMAGE_DATA_URL =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='96' height='96'%3E%3Crect width='96' height='96' fill='%23ff00a8'/%3E%3Cpath d='M0 0h48v48H0zm48 48h48v48H48z' fill='%23000'/%3E%3C/svg%3E";

export function mountRuntimeProof(document: Document): HTMLElement {
  const existingHost = document.getElementById(RUNTIME_PROOF_HOST_ID);
  if (existingHost instanceof HTMLElement) {
    return existingHost;
  }

  const host = document.createElement("pixel-pincher-runtime-proof");
  host.id = RUNTIME_PROOF_HOST_ID;

  const shadowRoot = host.attachShadow({ mode: "open" });
  const image = document.createElement("img");
  image.alt = "Pixel Pincher runtime proof image";
  image.height = 96;
  image.width = 96;
  image.src = PROOF_IMAGE_DATA_URL;

  const status = document.createElement("p");
  status.textContent = "Runtime proof image is loading…";

  image.addEventListener("load", () => {
    host.dataset.imageStatus = "loaded";
    status.textContent = "Runtime proof image loaded.";
  });
  image.addEventListener("error", () => {
    host.dataset.imageStatus = "error";
    status.textContent = "Runtime proof image was blocked or failed to load.";
  });

  shadowRoot.append(image, status);

  const root = document.body ?? document.documentElement;
  root.append(host);
  return host;
}
