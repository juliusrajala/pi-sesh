export class PiSeshError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PiSeshError";
    this.code = code;
  }
}
