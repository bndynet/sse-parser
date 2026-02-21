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
  | { type: 'text'; content: string }
  | { type: 'reasoning'; content: string }
  | { type: 'tool_call'; id: string; name: string; arguments: string }
  | { type: 'error'; message: string; code?: string }
  | { type: 'done'; usage?: TokenUsage };
