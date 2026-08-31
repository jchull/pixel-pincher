export type ReadBoundedResponseResult =
  | Readonly<{ ok: true; bytes: Uint8Array<ArrayBuffer> }>
  | Readonly<{ ok: false; reason: "too-large" | "read-failed" }>;

/**
 * Reads a response body without retaining more than the accepted chunks and
 * one incoming chunk. The caller owns the applicable source-byte limit.
 */
export async function readBoundedResponse(
  response: Response,
  maximumBytes: number,
): Promise<ReadBoundedResponseResult> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0)
    return { ok: false, reason: "read-failed" };

  const contentLength = parseContentLength(
    response.headers.get("content-length"),
  );
  if (contentLength !== null && contentLength > maximumBytes)
    return { ok: false, reason: "too-large" };

  if (response.body === null) return { ok: false, reason: "read-failed" };

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = next.value;
      totalBytes += chunk.byteLength;
      if (totalBytes > maximumBytes) {
        void reader.cancel().catch(() => undefined);
        return { ok: false, reason: "too-large" };
      }
      chunks.push(chunk);
    }
  } catch {
    return { ok: false, reason: "read-failed" };
  }

  const bytes = new Uint8Array(new ArrayBuffer(totalBytes));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes };
}

function parseContentLength(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value)) return null;
  const length = Number(value);
  return Number.isSafeInteger(length) ? length : null;
}
