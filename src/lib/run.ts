export type RunRequest = {
  model: string;
  cwd: string;
  prompt: string;
  readonly: boolean;
};

export class NotImplementedError extends Error {
  constructor() {
    super("neo: the agent loop is not implemented yet");
    this.name = "NotImplementedError";
  }
}

export async function run(_request: RunRequest): Promise<string> {
  throw new NotImplementedError();
}
