/**
 * fetch with a hard per-request timeout.
 *
 * The report runs inside a serverless function with a strict overall time
 * budget. Without a per-call ceiling, one slow upstream API (Meta's insights
 * endpoint can be slow) can consume the whole budget and time out the entire
 * function — producing no report at all. With a ceiling, a slow call fails fast,
 * gets caught, and the report still goes out with a "data unavailable" notice.
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    // Normalize the abort error into something readable in logs/alerts.
    if (err instanceof DOMException && err.name === "TimeoutError") {
      throw new Error(`Request timed out after ${timeoutMs}ms: ${url.split("?")[0]}`);
    }
    throw err;
  }
}
