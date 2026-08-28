import { describe, expect, it } from "vitest";

import { getChromeApiDouble } from "./setup";

describe("test tooling", () => {
  it("provides a real JSDOM document", () => {
    const marker = document.createElement("p");
    marker.id = "tooling-marker";
    marker.textContent = "tooling";
    document.body.append(marker);

    expect(document.querySelector("#tooling-marker")?.textContent).toBe("tooling");
    expect(marker.ownerDocument).toBe(document);
  });

  it("installs a fresh Chrome permission double per test", async () => {
    const granted = await getChromeApiDouble().permissions.request({
      origins: ["https://example.com/*"],
    });

    expect(granted).toBe(true);
    expect(getChromeApiDouble().permissions.request).toHaveBeenCalledTimes(1);
    expect(getChromeApiDouble().permissions.request).toHaveBeenCalledWith({
      origins: ["https://example.com/*"],
    });
  });
});
