import type { Readable, Writable } from "node:stream";

export type Prompter = {
  ask: (question: string) => Promise<string | undefined>;
  askBody: (question: string) => Promise<string | undefined>;
};

export function createPrompter(input: Readable, output: Writable): Prompter {
  const lines = iterateLines(input);
  return {
    async ask(question: string): Promise<string | undefined> {
      output.write(question);
      const next = await lines.next();
      if (next.done) {
        return undefined;
      }
      return next.value;
    },
    async askBody(question: string): Promise<string | undefined> {
      output.write(question.endsWith("\n") ? question : `${question}\n`);
      const collected: string[] = [];
      for (;;) {
        const next = await lines.next();
        if (next.done) {
          break;
        }
        collected.push(next.value);
      }
      if (collected.length === 0) {
        return undefined;
      }
      return collected.join("\n");
    },
  };
}

async function* iterateLines(input: Readable): AsyncGenerator<string> {
  input.setEncoding("utf8");
  let buffer = "";
  for await (const chunk of input) {
    buffer += typeof chunk === "string" ? chunk : String(chunk);
    for (;;) {
      const nl = buffer.indexOf("\n");
      if (nl === -1) {
        break;
      }
      yield stripCr(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
    }
  }
  if (buffer.length > 0) {
    yield stripCr(buffer);
  }
}

function stripCr(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}
