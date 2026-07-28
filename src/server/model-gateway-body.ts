export type BoundedTextResult =
  | { kind: "invalid" }
  | { kind: "ok"; value: string }
  | { kind: "too_large" };

export async function readBoundedText(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<BoundedTextResult> {
  if (!body) {
    return { kind: "ok", value: "" };
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      totalBytes += chunk.value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { kind: "too_large" };
      }
      chunks.push(chunk.value);
    }
  } catch (_error) {
    return { kind: "invalid" };
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return {
      kind: "ok",
      value: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    };
  } catch (_error) {
    return { kind: "invalid" };
  }
}
