import { describe, expect, it } from "vitest";

import { RUNTIME_PROOF_HOST_ID, mountRuntimeProof } from "../src/proof/runtime-content";
import { getChromeApiDouble } from "./setup";

describe("runtime content proof seam", () => {
  it("creates one Shadow DOM host with a data URL image", () => {
    const firstHost = mountRuntimeProof(document);
    const secondHost = mountRuntimeProof(document);

    expect(secondHost).toBe(firstHost);
    expect(firstHost.id).toBe(RUNTIME_PROOF_HOST_ID);

    const image = firstHost.shadowRoot?.querySelector("img");
    expect(image).not.toBeNull();
    expect(image?.getAttribute("src")).toMatch(/^data:image\/svg\+xml,/);
    expect(image?.width).toBe(96);

    image?.dispatchEvent(new Event("load"));
    expect(firstHost.dataset.imageStatus).toBe("loaded");
    expect(firstHost.shadowRoot?.textContent).toContain("loaded");

    image?.dispatchEvent(new Event("error"));
    expect(firstHost.dataset.imageStatus).toBe("error");
    expect(firstHost.shadowRoot?.textContent).toContain("blocked");
  });

  it("uses the Chrome permission double without a background relay", async () => {
    const granted = await getChromeApiDouble().permissions.request({
      origins: ["https://example.com/*"],
    });

    expect(granted).toBe(true);
    expect(getChromeApiDouble().permissions.request).toHaveBeenCalledWith({
      origins: ["https://example.com/*"],
    });
  });
});
