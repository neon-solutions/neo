import { spawn } from "node:child_process";
import { NeoError } from "./errors";
import { clip } from "./paths";

/**
 * How long the pipes may stay open after bash exits: enough to drain its last output, short enough that a process it
 * left running in the background with the pipes still open can't hold the call.
 */
const DRAIN_MS = 200;

export type BashResult = { code: number; stdout: string; stderr: string };

/**
 * Runs `bash -lc command` in its own process group and resolves when bash exits. Waiting for the pipes to close
 * instead hangs on `cd dir && server &`: bash backgrounds the whole list in a subshell that keeps them open for as
 * long as the server runs. A timeout kills the group.
 */
export function runBash(command: string, cwd: string, timeoutMs: number): Promise<BashResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", ["-lc", command], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child.pid);
    }, timeoutMs);

    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        clearTimeout(drain);
        child.stdout.destroy();
        child.stderr.destroy();
        if (timedOut) {
          reject(new NeoError(`neo: bash timed out after ${timeoutMs}ms`));
          return;
        }
        resolve({ code: code ?? 1, stdout: clip(stdout), stderr: clip(stderr) });
      };
      const drain = setTimeout(settle, DRAIN_MS);
      child.once("close", settle);
    });
  });
}

function killGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    // The group already exited between the timer firing and the kill.
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
  }
}
