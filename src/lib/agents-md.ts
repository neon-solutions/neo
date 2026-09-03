import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { NeoError } from "./errors";
import { errorCode, walkToGitRoot } from "./paths";

export async function loadAgentsMd(cwd: string): Promise<string> {
  const dirs = walkToGitRoot(cwd).slice().reverse();
  const sections: string[] = [];

  for (const dir of dirs) {
    const file = join(dir, "AGENTS.md");
    try {
      const content = await readFile(file, "utf8");
      sections.push(`## ${file}\n\n${content.trimEnd()}`);
    } catch (error) {
      const code = errorCode(error);
      if (code === "ENOENT") {
        continue;
      }
      if (code === "EISDIR") {
        throw new NeoError(`neo: AGENTS.md is a directory: ${file}`);
      }
      throw error;
    }
  }

  if (sections.length === 0) {
    throw new NeoError(
      `neo: --agents-md is set but no AGENTS.md was found between ${resolve(cwd)} and the git root`,
    );
  }

  return `# AGENTS.md\n\n${sections.join("\n\n")}`;
}
