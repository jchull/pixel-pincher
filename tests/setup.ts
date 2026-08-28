import { beforeEach, vi } from "vitest";

type ChromeApiDouble = Readonly<{
  permissions: Readonly<{
    request: ReturnType<typeof vi.fn>;
  }>;
}>;

let chromeApiDouble: ChromeApiDouble | undefined;

export function getChromeApiDouble(): ChromeApiDouble {
  if (chromeApiDouble === undefined) {
    throw new Error("Chrome API double has not been installed.");
  }

  return chromeApiDouble;
}

beforeEach(() => {
  chromeApiDouble = {
    permissions: {
      request: vi.fn().mockResolvedValue(true),
    },
  };

  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: chromeApiDouble,
    writable: true,
  });
});
