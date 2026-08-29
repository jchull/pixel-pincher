import { describe, expect, it, vi } from "vitest";

import type { ContentRequest } from "../../src/shared/contracts";
import { TabMessenger } from "../../src/background/tab-messenger";

const request: ContentRequest = { kind: "clear-overlay", revision: 1 };

describe("TabMessenger", () => {
  it("injects the same tab and retries once for a missing receiver", async () => {
    const send = vi.fn()
      .mockRejectedValueOnce(new Error("Could not establish connection. Receiving end does not exist."))
      .mockResolvedValueOnce(undefined);
    const inject = vi.fn().mockResolvedValue({ ok: true, value: undefined });
    const messenger = new TabMessenger({ send }, { inject });

    await expect(messenger.deliver(8, request)).resolves.toEqual({ ok: true, value: undefined });
    expect(inject).toHaveBeenCalledOnce();
    expect(inject).toHaveBeenCalledWith(8);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("does not inject or retry non-receiver failures", async () => {
    const send = vi.fn().mockRejectedValue(new Error("The tab was closed."));
    const inject = vi.fn();
    const messenger = new TabMessenger({ send }, { inject });

    const delivered = await messenger.deliver(8, request);
    expect(delivered.ok).toBe(false);
    expect(inject).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledOnce();
  });
});
