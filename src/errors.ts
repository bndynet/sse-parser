/**
 * Base class for all SSE-related errors.
 */
export class SSEError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SSEError';
  }
}

/**
 * Thrown (or reported via callback) when a single SSE line or JSON payload
 * cannot be parsed.  This is typically non-fatal — the stream continues.
 */
export class SSEParseError extends SSEError {
  /** The raw line that failed to parse. */
  readonly line: string;

  constructor(message: string, line: string) {
    super(message);
    this.name = 'SSEParseError';
    this.line = line;
  }
}

/**
 * Thrown when the underlying HTTP / network connection fails.
 */
export class SSEConnectionError extends SSEError {
  /** HTTP status code, if available. */
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'SSEConnectionError';
    this.status = status;
  }
}

/**
 * Thrown when no data arrives within the configured idle-timeout window.
 */
export class SSETimeoutError extends SSEError {
  /** The timeout threshold that was exceeded (ms). */
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`SSE stream idle for ${timeoutMs}ms — timeout`);
    this.name = 'SSETimeoutError';
    this.timeoutMs = timeoutMs;
  }
}
