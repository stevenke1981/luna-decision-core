/** Stable decision error codes exposed by the SDK and the transports. */
export class DecisionError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.code = code;
  }
}

export function errorCode(error, fallback = 'INTERNAL_ERROR') {
  return error instanceof DecisionError ? error.code : fallback;
}
