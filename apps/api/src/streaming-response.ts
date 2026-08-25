/**
 * Prevents nginx and similar VPS proxies from buffering oRPC's event stream. Without
 * these headers the server can emit immediately while the other device sees a batch later.
 */
export function withStreamingHeaders(response: Response): Response {
  if (!response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")) {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-cache, no-transform");
  headers.set("x-accel-buffering", "no");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
