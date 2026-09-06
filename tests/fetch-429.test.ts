import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { fetchWith429Retry } from "../src/lib/fetch-429";
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

test("fetchWith429Retry retries a POST Request body", async () => {
  const bodies: string[] = [];
  let hit = 0;
  const { baseURL, close } = await listen((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    req.on("end", () => {
      bodies.push(Buffer.concat(chunks).toString("utf8"));
      hit += 1;
      if (hit === 1) {
        res.writeHead(429);
        res.end("slow down");
        return;
      }
      res.writeHead(200);
      res.end("ok");
    });
  });
  try {
    const request = new Request(baseURL, {
      method: "POST",
      body: JSON.stringify({ model: "claude-fable-5" }),
      headers: { "Content-Type": "application/json" },
    });
    const response = await fetchWith429Retry(request);
    expect(response.status).toBe(200);
    expect(bodies).toEqual([
      JSON.stringify({ model: "claude-fable-5" }),
      JSON.stringify({ model: "claude-fable-5" }),
    ]);
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
    expect(result.stderr).toContain("retrying (1/3)");
    expect(seq.hits()).toBe(2);
  } finally {
    await close();
  }
});
