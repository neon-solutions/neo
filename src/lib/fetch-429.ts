const MAX_429_RETRIES = 3;
const PAUSE_MS = [200, 400, 800] as const;
const MAX_RETRY_AFTER_MS = 2_000;

export async function fetchWith429Retry(...args: Parameters<typeof fetch>): Promise<Response> {
  const input = args[0];
  const init = args[1];
  const prototype = input instanceof Request ? input : undefined;
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(prototype !== undefined ? prototype.clone() : input, init);
    if (response.status !== 429 || attempt >= MAX_429_RETRIES || aborted(input, init)) {
      return response;
    }
    await discardBody(response);
    const delay = pauseMs(response, attempt);
    process.stderr.write(
      `neo: gateway 429, retrying (${String(attempt + 1)}/${String(MAX_429_RETRIES)})\n`,
    );
    await sleep(delay);
  }
}

function aborted(input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]): boolean {
  if (init?.signal?.aborted === true) {
    return true;
  }
  return input instanceof Request && input.signal.aborted;
}

function pauseMs(response: Response, attempt: number): number {
  const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
  if (retryAfter !== undefined) {
    return Math.min(retryAfter, MAX_RETRY_AFTER_MS);
  }
  const pause = PAUSE_MS[attempt];
  if (pause !== undefined) {
    return pause;
  }
  return 800;
}

function parseRetryAfter(value: string | null): number | undefined {
  if (value === null || value.length === 0) {
    return undefined;
  }
  if (/^[0-9]+$/.test(value)) {
    return Number(value) * 1000;
  }
  const date = Date.parse(value);
  if (Number.isNaN(date)) {
    return undefined;
  }
  return Math.max(0, date - Date.now());
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.arrayBuffer();
  } catch {
    // Connection may already be closed; the retry still proceeds.
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
