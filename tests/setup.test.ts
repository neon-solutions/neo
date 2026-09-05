import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, expect, test } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const setupSh = join(root, "setup.sh");
const fixture = Buffer.from("#!/bin/bash\necho neo-fixture\n");
const os = execFileSync("uname", ["-s"], { encoding: "utf8" }).trim().toLowerCase();
const arch = execFileSync("uname", ["-m"], { encoding: "utf8" }).trim();
const asset = `neo-${os}-${arch}`;
const dirs: string[] = [];

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "neo-setup-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

let server: http.Server;
let port: number;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === `/${asset}`) {
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Length": fixture.length,
      });
      res.end(fixture);
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  if (addr === null || typeof addr === "string") {
    throw new Error("expected a TCP address");
  }
  port = addr.port;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
});

function releaseUrl(): string {
  return `http://127.0.0.1:${port}`;
}

function runSetup(
  env: NodeJS.ProcessEnv,
  options?: { argv?: string[]; input?: string },
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/bash", options?.argv ?? [setupSh], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(options?.input ?? "");
  });
}

function baseEnv(home: string, binDir: string, extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: home,
    SHELL: "/bin/zsh",
    PATH: `/usr/bin:/bin:/usr/sbin:/sbin:${process.env.PATH ?? ""}`,
    NEO_INSTALL_DIR: binDir,
    NEO_RELEASE_URL: releaseUrl(),
    ...extra,
  };
}

test("installs the matching asset into NEO_INSTALL_DIR", async () => {
  const home = tmp();
  const binDir = join(tmp(), "bin");
  const dest = join(binDir, "neo");
  const result = await runSetup(baseEnv(home, binDir));
  expect(result.status).toBe(0);
  expect(result.stdout).toBe(`${dest}\n`);
  expect(result.stderr).toContain("installed neo to ");
  expect(existsSync(dest)).toBe(true);
  expect(statSync(dest).mode & 0o111).not.toBe(0);
  expect(readFileSync(dest)).toEqual(fixture);
  expect(execFileSync(dest, { encoding: "utf8" })).toBe("neo-fixture\n");
  expect(readdirSync(binDir).filter((name) => name.startsWith(".neo.tmp."))).toEqual([]);
});

test("overwrites an existing binary", async () => {
  const home = tmp();
  const binDir = join(tmp(), "bin");
  mkdirSync(binDir, { recursive: true });
  const dest = join(binDir, "neo");
  writeFileSync(dest, "old-binary");
  const result = await runSetup(baseEnv(home, binDir));
  expect(result.status).toBe(0);
  expect(readFileSync(dest)).toEqual(fixture);
});

test("appends PATH to zshrc once", async () => {
  const home = tmp();
  const binDir = join(tmp(), "bin");
  const env = baseEnv(home, binDir, { PATH: "/usr/bin:/bin" });
  const first = await runSetup(env);
  expect(first.status).toBe(0);
  const zshrc = readFileSync(join(home, ".zshrc"), "utf8");
  expect(zshrc).toContain(`export PATH="${binDir}:$PATH"`);
  expect(zshrc.split(`export PATH="${binDir}:$PATH"`).length - 1).toBe(1);
  const second = await runSetup(env);
  expect(second.status).toBe(0);
  expect(
    readFileSync(join(home, ".zshrc"), "utf8").split(`export PATH="${binDir}:$PATH"`).length - 1,
  ).toBe(1);
});

test("writes zshrc even when the install dir is already on PATH", async () => {
  const home = tmp();
  const binDir = join(tmp(), "bin");
  const result = await runSetup(baseEnv(home, binDir, { PATH: `${binDir}:/usr/bin:/bin` }));
  expect(result.status).toBe(0);
  expect(readFileSync(join(home, ".zshrc"), "utf8")).toContain(`export PATH="${binDir}:$PATH"`);
});

test("appends after a file that has no trailing newline", async () => {
  const home = tmp();
  const binDir = join(tmp(), "bin");
  writeFileSync(join(home, ".zshrc"), "existing-line");
  const result = await runSetup(baseEnv(home, binDir, { PATH: "/usr/bin:/bin" }));
  expect(result.status).toBe(0);
  const zshrc = readFileSync(join(home, ".zshrc"), "utf8");
  expect(zshrc.startsWith("existing-line\n")).toBe(true);
  expect(zshrc).toContain(`export PATH="${binDir}:$PATH"`);
});

test("does not treat a substring mention as the managed PATH line", async () => {
  const home = tmp();
  const binDir = join(tmp(), "bin");
  writeFileSync(join(home, ".zshrc"), `# mention ${binDir} in a comment\n`);
  const result = await runSetup(baseEnv(home, binDir, { PATH: "/usr/bin:/bin" }));
  expect(result.status).toBe(0);
  expect(readFileSync(join(home, ".zshrc"), "utf8")).toContain(`export PATH="${binDir}:$PATH"`);
});

test("writes bashrc and bash_profile for bash", async () => {
  const home = tmp();
  const binDir = join(tmp(), "bin");
  const result = await runSetup(
    baseEnv(home, binDir, { SHELL: "/bin/bash", PATH: "/usr/bin:/bin" }),
  );
  expect(result.status).toBe(0);
  const line = `export PATH="${binDir}:$PATH"`;
  expect(readFileSync(join(home, ".bashrc"), "utf8")).toContain(line);
  expect(readFileSync(join(home, ".bash_profile"), "utf8")).toContain(line);
});

test("creates fish config.fish", async () => {
  const home = tmp();
  const binDir = join(tmp(), "bin");
  const result = await runSetup(
    baseEnv(home, binDir, { SHELL: "/usr/bin/fish", PATH: "/usr/bin:/bin" }),
  );
  expect(result.status).toBe(0);
  expect(readFileSync(join(home, ".config", "fish", "config.fish"), "utf8")).toContain(
    `set -gx PATH ${binDir} $PATH`,
  );
  expect(result.stderr).toContain(`set -gx PATH ${binDir} $PATH`);
});

test("rejects an unsupported platform before downloading", async () => {
  const home = tmp();
  const binDir = join(tmp(), "bin");
  const shim = join(tmp(), "shim");
  mkdirSync(shim);
  writeFileSync(
    join(shim, "uname"),
    `#!/bin/bash
case "$1" in
  -s) printf 'Linux\\n' ;;
  -m) printf 'aarch64\\n' ;;
  *) printf 'Linux\\n' ;;
esac
`,
  );
  chmodSync(join(shim, "uname"), 0o755);
  const result = await runSetup(baseEnv(home, binDir, { PATH: `${shim}:/usr/bin:/bin` }));
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("unsupported platform: linux-aarch64");
  expect(existsSync(join(binDir, "neo"))).toBe(false);
});

test("leaves an existing binary in place when the download 404s", async () => {
  const home = tmp();
  const binDir = join(tmp(), "bin");
  mkdirSync(binDir, { recursive: true });
  const dest = join(binDir, "neo");
  writeFileSync(dest, "keep-me");
  const result = await runSetup(
    baseEnv(home, binDir, { NEO_RELEASE_URL: `${releaseUrl()}/missing` }),
  );
  expect(result.status).not.toBe(0);
  expect(readFileSync(dest, "utf8")).toBe("keep-me");
  expect(readdirSync(binDir).filter((name) => name.startsWith(".neo.tmp."))).toEqual([]);
});

test("rejects a NEO_INSTALL_DIR that cannot be written into an rc file", async () => {
  const home = tmp();
  const result = await runSetup(baseEnv(home, `/tmp/neo"bin`));
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("NEO_INSTALL_DIR");
});

test("errors when curl and wget are both missing", async () => {
  const home = tmp();
  const binDir = join(tmp(), "bin");
  const tools = join(tmp(), "tools");
  mkdirSync(tools);
  const names = [
    "uname",
    "tr",
    "mktemp",
    "mkdir",
    "chmod",
    "mv",
    "rm",
    "grep",
    "basename",
    "dirname",
    "tail",
  ];
  for (const name of names) {
    const resolved = execFileSync("/bin/bash", ["-lc", `command -v ${name}`], {
      encoding: "utf8",
    }).trim();
    symlinkSync(resolved, join(tools, name));
  }
  const result = await runSetup(baseEnv(home, binDir, { PATH: tools }));
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("curl or wget is required");
  expect(existsSync(join(binDir, "neo"))).toBe(false);
});

test("bash -s matches curl | bash stdin", async () => {
  const home = tmp();
  const binDir = join(tmp(), "bin");
  const dest = join(binDir, "neo");
  const result = await runSetup(baseEnv(home, binDir), {
    argv: ["-s"],
    input: readFileSync(setupSh, "utf8"),
  });
  expect(result.status).toBe(0);
  expect(result.stdout).toBe(`${dest}\n`);
  expect(readFileSync(dest)).toEqual(fixture);
});
