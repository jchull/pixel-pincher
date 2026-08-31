import { describe, expect, it, vi } from "vitest";

import { readBoundedResponse } from "../../src/content/read-bounded-response";
import { MAX_IMAGE_RAW_BYTES } from "../../src/shared/contracts";

function responseFromChunks(
  chunks: readonly Uint8Array[],
  options: Readonly<{ contentLength?: string; cancel?: () => void }> = {},
): Response {
  let index = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller): void {
      const chunk = chunks[index++];
      if (chunk === undefined) controller.close();
      else controller.enqueue(chunk);
    },
    cancel: options.cancel,
  });
  return new Response(stream, {
    headers:
      options.contentLength === undefined
        ? undefined
        : { "content-length": options.contentLength },
  });
}

describe("readBoundedResponse", () => {
  it("rejects an oversized declared content length before reading", async () => {
    const response = new Response(
      new ReadableStream<Uint8Array>({}),
      { headers: { "content-length": String(MAX_IMAGE_RAW_BYTES + 1) } },
    );

    await expect(readBoundedResponse(response, MAX_IMAGE_RAW_BYTES)).resolves.toEqual({
      ok: false,
      reason: "too-large",
    });
  });

  it("cancels chunked data as soon as it crosses the limit", async () => {
    const cancel = vi.fn();
    const response = responseFromChunks(
      [new Uint8Array(MAX_IMAGE_RAW_BYTES), new Uint8Array([1])],
      { cancel },
    );

    await expect(readBoundedResponse(response, MAX_IMAGE_RAW_BYTES)).resolves.toEqual({
      ok: false,
      reason: "too-large",
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("accepts an allowed response exactly at the limit", async () => {
    const bytes = new Uint8Array(MAX_IMAGE_RAW_BYTES);

    const result = await readBoundedResponse(
      responseFromChunks([bytes]),
      MAX_IMAGE_RAW_BYTES,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.bytes.byteLength).toBe(MAX_IMAGE_RAW_BYTES);
      expect(result.bytes[0]).toBe(0);
      expect(result.bytes.at(-1)).toBe(0);
    }
  });

  it("fails closed when the response has no readable body", async () => {
    await expect(
      readBoundedResponse(new Response(null), MAX_IMAGE_RAW_BYTES),
    ).resolves.toEqual({ ok: false, reason: "read-failed" });
  });
});
