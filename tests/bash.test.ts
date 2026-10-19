import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { runBash } from "../src/lib/bash";

test("returns output and the exit code", () => {
  expect(runBash("echo out; echo err >&2; exit 3", tmpdir(), 5_000)).toEqual({
    code: 3,
    stdout: "out\n",
    stderr: "err\n",
  });
});

test("returns while a server it started in the background keeps running", async () => {
  const dir = mkdtempSync(join(tmpdir(), "neo-bash-"));
  const started = Date.now();
  // `&` backgrounds the whole `&&` list in a subshell that holds stdout open until the loop ends.
  const result = runBash(
    `cd ${dir} && for i in 1 2 3; do echo $i >> ticks; sleep 1; done > /dev/null 2>&1 < /dev/null &`,
    tmpdir(),
    10_000,
  );
  expect(result.code).toBe(0);
  expect(Date.now() - started).toBeLessThan(2_000);
  await new Promise((done) => setTimeout(done, 3_500));
  expect(readFileSync(join(dir, "ticks"), "utf8")).toBe("1\n2\n3\n");
});

test("returns a background command's output written before bash exits", () => {
  expect(runBash("(echo early) & wait; echo late", tmpdir(), 5_000).stdout).toBe("early\nlate\n");
});

test("a command past its timeout fails with the limit", () => {
  expect(() => runBash("sleep 30", tmpdir(), 500)).toThrow("neo: bash timed out after 500ms");
});
