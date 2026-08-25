export const LLM_TIMEOUT_MS = 120_000;
export const LLM_RETRY_ATTEMPTS = 2;
export const LLM_RETRY_BASE_MS = 500;

export function isRetryableLlmError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (/aborted|timeout|timed out/i.test(message)) return true;
  if (/\b(429|502|503|504)\b/.test(message)) return true;
  if (/rate limit|overloaded|temporar|econnreset|enotfound|fetch failed/i.test(message)) {
    return true;
  }
  return false;
}

export async function withTimeout<T>(
  work: (signal: AbortSignal) => Promise<T>,
  ms: number,
  parent?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const onParent = () => controller.abort();
  if (parent?.aborted) controller.abort();
  parent?.addEventListener("abort", onParent);
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await Promise.race([
      work(controller.signal),
      new Promise<T>((_, reject) => {
        const fail = () => {
          reject(
            parent?.aborted ? new Error("aborted") : new Error(`LLM call timed out after ${ms}ms`),
          );
        };
        if (controller.signal.aborted) fail();
        else controller.signal.addEventListener("abort", fail, { once: true });
      }),
    ]);
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener("abort", onParent);
  }
}

export async function withRetry<T>(
  work: (attempt: number) => Promise<T>,
  opts?: { attempts?: number; baseMs?: number; shouldRetry?: (error: unknown) => boolean },
): Promise<T> {
  const attempts = opts?.attempts ?? LLM_RETRY_ATTEMPTS;
  const baseMs = opts?.baseMs ?? LLM_RETRY_BASE_MS;
  const shouldRetry = opts?.shouldRetry ?? isRetryableLlmError;
  let last: unknown;
  for (let attempt = 0; attempt <= attempts; attempt += 1) {
    try {
      return await work(attempt);
    } catch (error) {
      last = error;
      if (attempt === attempts || !shouldRetry(error)) throw error;
      await sleep(baseMs * 2 ** attempt);
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
