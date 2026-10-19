import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NeoError } from "./errors";
import { clip } from "./paths";

export type BashResult = { code: number; stdout: string; stderr: string };

/**
 * Runs `command` in a login bash that sends its stdout and stderr to files rather than pipes, so it returns when bash exits. With
 * pipes, `spawnSync` waits for every process holding them to close them, and `cd dir && server &` never does: bash
 * backgrounds the whole list in a subshell that keeps them open for as long as the server runs.
 */
export function runBash(command: string, cwd: string, timeoutMs: number): BashResult {
  const dir = mkdtempSync(join(tmpdir(), "neo-bash-"));
  const stdoutPath = join(dir, "stdout");
  const stderrPath = join(dir, "stderr");
  const previous = process.cwd();
  process.chdir(cwd);
  try {
    const result = spawnSync(
      "bash",
      ["-lc", 'exec >"$1" 2>"$2"; eval "$3"', "neo", stdoutPath, stderrPath, command],
      {
        timeout: timeoutMs,
        stdio: "ignore",
      },
    );
    const spawnError = result.error;
    if (spawnError) {
      if (spawnError.message.includes("ETIMEDOUT")) {
        throw new NeoError(`neo: bash timed out after ${timeoutMs}ms`);
      }
      throw spawnError;
    }
    return {
      code: result.status === null ? 1 : result.status,
      stdout: clip(readFileSync(stdoutPath, "utf8")),
      stderr: clip(readFileSync(stderrPath, "utf8")),
    };
  } finally {
    process.chdir(previous);
    rmSync(dir, { recursive: true, force: true });
  }
}
