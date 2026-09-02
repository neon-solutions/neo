export class NeoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NeoError";
  }
}
