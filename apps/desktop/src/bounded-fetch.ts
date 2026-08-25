export const DEFAULT_FETCH_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024;

export interface BoundedFetchOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBytes?: number;
}

export async function boundedFetchText(
  input: string | URL,
  fetchImpl: typeof fetch,
  options: BoundedFetchOptions = {},
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  options.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const response = await fetchImpl(input, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Request failed (${response.status}).`);
    }
    const lengthHeader = response.headers.get("content-length");
    if (lengthHeader && Number(lengthHeader) > maxBytes) {
      throw new Error("Response exceeds size limit.");
    }
    const reader = response.body?.getReader();
    if (!reader) return (await response.text()).slice(0, maxBytes);
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new Error("Response exceeds size limit.");
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}
