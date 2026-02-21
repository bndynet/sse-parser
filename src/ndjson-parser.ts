import type { NDJSONParserCallbacks } from './types.js';
import { SSEParseError } from './errors.js';

/**
 * Newline-Delimited JSON (NDJSON) push parser.
 *
 * Used by APIs like Ollama that stream JSON objects separated by newlines
 * instead of using the SSE protocol.
 *
 * Feed arbitrary text chunks via `feed()`.  Each complete line is parsed
 * as JSON and forwarded through the `onValue` callback.  Malformed lines
 * are reported via `onError` (non-fatal — parsing continues).
 */
export class NDJSONParser<T = unknown> {
  private readonly cb: NDJSONParserCallbacks<T>;
  private buffer = '';

  constructor(callbacks: NDJSONParserCallbacks<T>) {
    this.cb = callbacks;
  }

  feed(chunk: string): void {
    this.buffer += chunk;

    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const raw = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);

      if (raw === '') continue;

      try {
        const value = JSON.parse(raw) as T;
        this.cb.onValue(value);
      } catch {
        const err = new SSEParseError(`Invalid JSON in NDJSON stream`, raw);
        this.cb.onError?.(err, raw);
      }
    }
  }

  /**
   * Flush any remaining buffered data.  Call once when the stream ends
   * so a final line without a trailing newline is not silently dropped.
   */
  flush(): void {
    const raw = this.buffer.trim();
    this.buffer = '';
    if (raw === '') return;

    try {
      const value = JSON.parse(raw) as T;
      this.cb.onValue(value);
    } catch {
      const err = new SSEParseError(`Invalid JSON in NDJSON stream`, raw);
      this.cb.onError?.(err, raw);
    }
  }

  reset(): void {
    this.buffer = '';
  }
}
