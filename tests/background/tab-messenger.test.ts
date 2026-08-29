import { describe, expect, it, vi } from "vitest";

import type { ContentRequest } from "../../src/shared/contracts";
import { TabMessenger, type TabPageResolver } from "../../src/background/tab-messenger";

const expectedUrl = new URL("https://example.test/page#one");
const request: ContentRequest = { kind: "clear-overlay", revision: 1 };

function stableTabs(): TabPageResolver {
  return { getTab: vi.fn().mockResolvedValue({ id: 8, url: "https://example.test/page#two" }) };
}

describe("TabMessenger", () => {
  it("injects the exact expected page in the same tab and retries once for a missing receiver", async () => {
    const send = vi.fn()
      .mockRejectedValueOnce(new Error("Could not establish connection. Receiving end does not exist."))
      .mockResolvedValueOnce(undefined);
    const inject = vi.fn().mockResolvedValue({ ok: true, value: undefined });
    const messenger = new TabMessenger({ send }, { inject }, stableTabs());

    await expect(messenger.deliver(8, expectedUrl, request)).resolves.toEqual({ ok: true, value: undefined });
    expect(inject).toHaveBeenCalledOnce();
    expect(inject).toHaveBeenCalledWith(8, expectedUrl);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenNthCalledWith(1, 8, request);
    expect(send).toHaveBeenNthCalledWith(2, 8, request);
  });

  it("does not inject or retry non-receiver failures", async () => {
    const send = vi.fn().mockRejectedValue(new Error("The tab was closed."));
    const inject = vi.fn();
    const messenger = new TabMessenger({ send }, { inject }, stableTabs());

    const delivered = await messenger.deliver(8, expectedUrl, request);
    expect(delivered.ok).toBe(false);
    expect(inject).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledOnce();
  });

  it("does not inject or retry when the tab navigates during missing-receiver recovery", async () => {
    const send = vi.fn().mockRejectedValue(new Error("Receiving end does not exist."));
    const inject = vi.fn();
    const tabs: TabPageResolver = {
      getTab: vi.fn()
        .mockResolvedValueOnce({ id: 8, url: expectedUrl.toString() })
        .mockResolvedValueOnce({ id: 8, url: "https://example.test/other" }),
    };
    const messenger = new TabMessenger({ send }, { inject }, tabs);

    await expect(messenger.deliver(8, expectedUrl, request)).resolves.toEqual({
      ok: false,
      error: expect.objectContaining({ code: "content-unavailable" }),
    });
    expect(inject).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledOnce();
  });

  it("does not retry after injection if the tab closes or navigates", async () => {
    const send = vi.fn().mockRejectedValue(new Error("Receiving end does not exist."));
    const inject = vi.fn().mockResolvedValue({ ok: true, value: undefined });
    const tabs: TabPageResolver = {
      getTab: vi.fn()
        .mockResolvedValueOnce({ id: 8, url: expectedUrl.toString() })
        .mockResolvedValueOnce({ id: 8, url: expectedUrl.toString() })
        .mockResolvedValueOnce(null),
    };
    const messenger = new TabMessenger({ send }, { inject }, tabs);

    await expect(messenger.deliver(8, expectedUrl, request)).resolves.toEqual({
      ok: false,
      error: expect.objectContaining({ code: "content-unavailable" }),
    });
    expect(inject).toHaveBeenCalledWith(8, expectedUrl);
    expect(send).toHaveBeenCalledOnce();
  });
});
