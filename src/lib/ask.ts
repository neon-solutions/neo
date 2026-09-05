import { readFileSync } from "node:fs";
import * as readline from "node:readline";

export type Prompter = {
  ask: (question: string) => Promise<string | undefined>;
  askBody: (question: string) => Promise<string | undefined>;
};

export function createPrompter(): Prompter {
  if (process.stdin.isTTY === true) {
    return createTtyPrompter();
  }
  return createPipedPrompter();
}

function createPipedPrompter(): Prompter {
  const text = readFileSync(0, "utf8");
  const raw = text.split("\n");
  const lines = raw.length > 0 && raw[raw.length - 1] === "" ? raw.slice(0, -1) : raw;
  let index = 0;
  return {
    async ask(question: string): Promise<string | undefined> {
      process.stderr.write(question);
      if (index >= lines.length) {
        return undefined;
      }
      const line = lines[index];
      index += 1;
      return line;
    },
    async askBody(question: string): Promise<string | undefined> {
      process.stderr.write(question.endsWith("\n") ? question : `${question}\n`);
      if (index >= lines.length) {
        return undefined;
      }
      const rest = lines.slice(index).join("\n");
      index = lines.length;
      return rest;
    },
  };
}

function createTtyPrompter(): Prompter {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  let closed = false;
  rl.on("close", () => {
    closed = true;
  });
  return {
    async ask(question: string): Promise<string | undefined> {
      process.stderr.write(question);
      if (closed) {
        return undefined;
      }
      return await new Promise((resolve) => {
        rl.question("", (answer) => {
          resolve(answer);
        });
      });
    },
    async askBody(question: string): Promise<string | undefined> {
      process.stderr.write(question.endsWith("\n") ? question : `${question}\n`);
      if (closed) {
        return undefined;
      }
      return await new Promise((resolve) => {
        const collected: string[] = [];
        let finished = false;
        const finish = (): void => {
          if (finished) {
            return;
          }
          finished = true;
          if (collected.length === 0) {
            resolve(undefined);
            return;
          }
          resolve(collected.join("\n"));
        };
        rl.on("close", finish);
        const readMore = (): void => {
          if (closed || finished) {
            finish();
            return;
          }
          rl.question("", (line) => {
            collected.push(line);
            readMore();
          });
        };
        readMore();
      });
    },
  };
}
