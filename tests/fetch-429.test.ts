import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { fetchWith429Retry, is429Error, retryOn429 } from "../src/lib/fetch-429";
import { createNeonGateway } from "../src/plugins/neon-ai-gateway";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "src/cli.ts");

async function listen(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ baseURL: string; close: () => Promise<void> }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  if (addr === null || typeof addr === "string") {
    throw new Error("expected a TCP address");
  }
  return {
    baseURL: `http://127.0.0.1:${String(addr.port)}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) {
            reject(err);
            return;
          }
          resolve();
        });
      }),
  };
}

function statusSequence(statuses: number[]): {
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void;
  hits: () => number;
} {
  let hit = 0;
  return {
    hits: () => hit,
    handler: (_req, res) => {
      const status = statuses[hit] ?? statuses[statuses.length - 1];
      hit += 1;
      if (status === 200) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "claude-fable-5", name: "Claude Fable 5" }] }));
        return;
      }
      res.writeHead(status ?? 500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "rate limited" } }));
    },
  };
}

test("fetchWith429Retry returns a 200 without retrying", async () => {
  const seq = statusSequence([200]);
  const { baseURL, close } = await listen(seq.handler);
  try {
    const response = await fetchWith429Retry(baseURL);
    expect(response.status).toBe(200);
    expect(seq.hits()).toBe(1);
  } finally {
    await close();
  }
});

test("fetchWith429Retry retries a 429 and then succeeds", async () => {
  const seq = statusSequence([429, 200]);
  const { baseURL, close } = await listen(seq.handler);
  try {
    const response = await fetchWith429Retry(baseURL);
    expect(response.status).toBe(200);
    expect(seq.hits()).toBe(2);
  } finally {
    await close();
  }
});

test("fetchWith429Retry retries a 429 three times", async () => {
  const seq = statusSequence([429, 429, 429, 200]);
  const { baseURL, close } = await listen(seq.handler);
  try {
    const response = await fetchWith429Retry(baseURL);
    expect(response.status).toBe(200);
    expect(seq.hits()).toBe(4);
  } finally {
    await close();
  }
});

test("fetchWith429Retry gives up after three 429 retries", async () => {
  const seq = statusSequence([429, 429, 429, 429]);
  const { baseURL, close } = await listen(seq.handler);
  try {
    const response = await fetchWith429Retry(baseURL);
    expect(response.status).toBe(429);
    expect(seq.hits()).toBe(4);
  } finally {
    await close();
  }
});

test("fetchWith429Retry does not retry a 500", async () => {
  const seq = statusSequence([500, 200]);
  const { baseURL, close } = await listen(seq.handler);
  try {
    const response = await fetchWith429Retry(baseURL);
    expect(response.status).toBe(500);
    expect(seq.hits()).toBe(1);
  } finally {
    await close();
  }
});

test("listModels recovers from a 429", async () => {
  const seq = statusSequence([429, 200]);
  const { baseURL, close } = await listen(seq.handler);
  const previousHome = process.env.HOME;
  const previousToken = process.env.NEON_AI_GATEWAY_TOKEN;
  const previousUrl = process.env.NEON_AI_GATEWAY_BASE_URL;
  process.env.HOME = mkdtempSync(join(tmpdir(), "neo-home-"));
  process.env.NEON_AI_GATEWAY_TOKEN = "test-token";
  process.env.NEON_AI_GATEWAY_BASE_URL = baseURL;
  try {
    const gateway = await createNeonGateway();
    const models = await gateway.listModels();
    expect(models).toEqual([{ id: "claude-fable-5", name: "Claude Fable 5" }]);
    expect(seq.hits()).toBe(2);
  } finally {
    await close();
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    if (previousToken === undefined) {
      delete process.env.NEON_AI_GATEWAY_TOKEN;
    } else {
      process.env.NEON_AI_GATEWAY_TOKEN = previousToken;
    }
    if (previousUrl === undefined) {
      delete process.env.NEON_AI_GATEWAY_BASE_URL;
    } else {
      process.env.NEON_AI_GATEWAY_BASE_URL = previousUrl;
    }
  }
});

test("neo models list recovers from a 429", async () => {
  const seq = statusSequence([429, 200]);
  const { baseURL, close } = await listen(seq.handler);
  const home = mkdtempSync(join(tmpdir(), "neo-home-"));
  try {
    const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>(
      (resolve, reject) => {
        const child = spawn("bun", [cli, "models", "list"], {
          cwd: root,
          env: {
            ...process.env,
            HOME: home,
            NEON_AI_GATEWAY_TOKEN: "test-token",
            NEON_AI_GATEWAY_BASE_URL: baseURL,
          },
        });
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          stdout += chunk;
        });
        child.stderr.on("data", (chunk: string) => {
          stderr += chunk;
        });
        child.on("error", reject);
        child.on("close", (status) => {
          resolve({ status, stdout, stderr });
        });
      },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("claude-fable-5");
    expect(seq.hits()).toBe(2);
  } finally {
    await close();
  }
});

test("retryOn429 retries a statusCode 429 then succeeds", async () => {
  let hits = 0;
  const value = await retryOn429(async () => {
    hits += 1;
    if (hits < 3) {
      throw Object.assign(new Error("rate limited"), { statusCode: 429 });
    }
    return "ok";
  });
  expect(value).toBe("ok");
  expect(hits).toBe(3);
});

test("retryOn429 gives up after three retries", async () => {
  let hits = 0;
  await expect(
    retryOn429(async () => {
      hits += 1;
      throw Object.assign(new Error("rate limited"), { statusCode: 429 });
    }),
  ).rejects.toMatchObject({ statusCode: 429 });
  expect(hits).toBe(4);
});

test("retryOn429 does not retry other errors", async () => {
  let hits = 0;
  await expect(
    retryOn429(async () => {
      hits += 1;
      throw new Error("boom");
    }),
  ).rejects.toThrow("boom");
  expect(hits).toBe(1);
});

test("is429Error reads nested cause", () => {
  const inner = Object.assign(new Error("limited"), { statusCode: 429 });
  const outer = Object.assign(new Error("wrapper"), { cause: inner });
  expect(is429Error(outer)).toBe(true);
  expect(is429Error(new Error("nope"))).toBe(false);
});
