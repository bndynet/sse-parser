// ---------------------------------------------------------------------------
// SSE Event (Layer 1 output)
// ---------------------------------------------------------------------------

export interface SSEEvent {
  /** Event type, defaults to "message" per WHATWG spec. */
  event: string;
  /** Joined multi-line data payload. */
  data: string;
  /** Last event ID string. */
  id: string;
  /** Reconnection time hint in milliseconds (set by `retry:` field). */
  retry?: number;
}

// ---------------------------------------------------------------------------
// SSE Parser options (push-based)
// ---------------------------------------------------------------------------

export interface SSEParserCallbacks {
  onEvent: (event: SSEEvent) => void;
  onComment?: (comment: string) => void;
  /** Reconnection-time hint (ms) from a `retry:` field. */
  onRetry?: (retryMs: number) => void;
  onError?: (error: Error) => void;
}

// ---------------------------------------------------------------------------
// NDJSON Parser options
// ---------------------------------------------------------------------------

export interface NDJSONParserCallbacks<T = unknown> {
  onValue: (value: T) => void;
  onError?: (error: Error, rawLine: string) => void;
}

// ---------------------------------------------------------------------------
// Stream input (Layer 2)
// ---------------------------------------------------------------------------

/**
 * Anything a stream reader / adapter can consume.
 *
 *   - `Response`         — a `fetch` Response; its `body` is read and the HTTP
 *                          status is validated (non-2xx throws `SSEConnectionError`).
 *   - `ReadableStream`   — a raw Web stream of bytes (e.g. `response.body`, or
 *                          the output of a `pipeThrough` transform). No HTTP
 *                          status check is performed.
 *   - `AsyncIterable`    — any async iterable yielding byte chunks or text
 *                          (e.g. a Node.js `http`/`undici` response stream, a
 *                          file stream, a child process' stdout, or a test
 *                          stub like an `async function*`). No HTTP status
 *                          check is performed.
 *
 * When passing a `ReadableStream` or `AsyncIterable`, the caller is responsible
 * for any transport-level (HTTP status / connection) validation.
 */
export type StreamInput =
  | Response
  | ReadableStream<Uint8Array>
  | AsyncIterable<Uint8Array | string>;

// ---------------------------------------------------------------------------
// Stream Reader options (Layer 2)
// ---------------------------------------------------------------------------

export interface StreamReaderOptions {
  /** Idle timeout in ms. Default 60 000. Set 0 to disable. */
  timeoutMs?: number;
  /** AbortSignal for external cancellation. */
  signal?: AbortSignal;
  /**
   * Sentinel string that signals the end of the stream.
   * For OpenAI-style APIs this is typically `"[DONE]"`.
   * When the `data` field of an SSE event equals this value the generator
   * returns instead of yielding the event.
   * Set to `null` to disable sentinel detection.
   * Default: `"[DONE]"`.
   */
  doneSentinel?: string | null;
}

// ---------------------------------------------------------------------------
// Unified ChatStream events (Layer 3 output)
// ---------------------------------------------------------------------------

export interface TokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export type ChatStreamEvent =
  | { type: 'text'; content: string; raw?: unknown }
  | { type: 'reasoning'; content: string; raw?: unknown }
  | {
      type: 'tool_call';
      id: string;
      name: string;
      arguments: string;
      /**
       * Stable index used to group streamed fragments of the SAME tool call.
       * Vendors emit a tool call's id/name once and its arguments across many
       * chunks; collect fragments sharing this index to reassemble the call.
       * Undefined when the vendor does not provide ordering information.
       */
      index?: number;
      raw?: unknown;
    }
  | { type: 'error'; message: string; code?: string; raw?: unknown }
  | {
      type: 'done';
      usage?: TokenUsage;
      /** Vendor-reported reason the generation stopped, when available. */
      finishReason?: string;
      raw?: unknown;
    };
