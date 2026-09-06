const MAX_429_RETRIES = 3;

export type GatewayInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
};

export async function fetchWith429Retry(input: string, init?: GatewayInit): Promise<Response> {
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(input, init);
    if (response.status !== 429 || attempt >= MAX_429_RETRIES) {
      return response;
    }
    await discardBody(response);
    await waitForRetry(response, attempt);
  }
}

export async function retryOn429(run: () => Promise<string>): Promise<string> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      if (!is429Error(error) || attempt >= MAX_429_RETRIES) {
        throw error;
      }
      await waitForRetry(undefined, attempt);
    }
  }
}

export function is429Error(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (!isRecord(current)) {
      return false;
    }
    if (current.statusCode === 429 || current.status === 429) {
      return true;
    }
    if (typeof current.message === "string" && current.message.includes("429")) {
      return true;
    }
    current = current.cause;
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function waitForRetry(response: Response | undefined, attempt: number): Promise<void> {
  process.stderr.write(
    `neo: gateway 429, retrying (${String(attempt + 1)}/${String(MAX_429_RETRIES)})\n`,
  );
  await sleep(pauseMs(response, attempt));
}

function pauseMs(response: Response | undefined, attempt: number): number {
  if (response !== undefined) {
    const retryAfter = parseRetryAfterSeconds(response.headers.get("retry-after"));
    if (retryAfter !== undefined) {
      const ms = retryAfter * 1000;
      if (ms < 2000) {
        return ms;
      }
      return 2000;
    }
  }
  if (attempt === 0) {
    return 200;
  }
  if (attempt === 1) {
    return 400;
  }
  return 800;
}

function parseRetryAfterSeconds(value: string | null): number | undefined {
  if (value === null || value.length === 0) {
    return undefined;
  }
  if (!/^[0-9]+$/.test(value)) {
    return undefined;
  }
  return Number(value);
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
