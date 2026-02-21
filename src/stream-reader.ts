import type { SSEEvent, StreamReaderOptions } from './types.js';
import { SSEParser } from './parser.js';
import { NDJSONParser } from './ndjson-parser.js';
import { SSEConnectionError, SSETimeoutError } from './errors.js';

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_DONE_SENTINEL = '[DONE]';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveOptions(opts?: StreamReaderOptions) {
  return {
    timeoutMs: opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    signal: opts?.signal,
    doneSentinel:
      opts?.doneSentinel === undefined
        ? DEFAULT_DONE_SENTINEL
        : opts.doneSentinel,
  };
}

function assertOkResponse(response: Response): void {
  if (!response.ok) {
    throw new SSEConnectionError(
      `HTTP ${response.status} ${response.statusText}`,
      response.status,
    );
  }
  if (!response.body) {
    throw new SSEConnectionError('Response body is null');
  }
}

// ---------------------------------------------------------------------------
// readSSEStream
// ---------------------------------------------------------------------------

/**
 * Consume a `fetch` Response whose body is an SSE text/event-stream and
 * yield parsed {@link SSEEvent} objects.
 *
 * The generator terminates when:
 *   1. A `data` field equals the configured `doneSentinel` (default `[DONE]`).
 *   2. The underlying ReadableStream signals `done`.
 *   3. The idle timeout expires.
 *   4. The caller's `AbortSignal` fires.
 */
export async function* readSSEStream(
  response: Response,
  options?: StreamReaderOptions,
): AsyncGenerator<SSEEvent> {
  assertOkResponse(response);

  const { timeoutMs, signal, doneSentinel } = resolveOptions(options);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();

  // Queue for events produced by the push parser
  let eventQueue: SSEEvent[] = [];
  let done = false;

  const parser = new SSEParser({
    onEvent(evt) {
      eventQueue.push(evt);
    },
  });

  let lastActivity = Date.now();

  try {
    while (!done) {
      // Abort check
      if (signal?.aborted) {
        throw new SSEConnectionError('Stream aborted by caller');
      }

      // Timeout check
      if (timeoutMs > 0 && Date.now() - lastActivity > timeoutMs) {
        throw new SSETimeoutError(timeoutMs);
      }

      const result = await reader.read();

      if (result.value) {
        lastActivity = Date.now();
        const text = decoder.decode(result.value, { stream: true });
        parser.feed(text);
      }

      // Yield all queued events
      while (eventQueue.length > 0) {
        const evt = eventQueue.shift()!;

        // Sentinel detection
        if (doneSentinel !== null && evt.data === doneSentinel) {
          done = true;
          break;
        }

        yield evt;
      }

      if (result.done) {
        // Flush remaining decoder bytes
        const trailing = decoder.decode();
        if (trailing) parser.feed(trailing);

        // Yield any final events
        while (eventQueue.length > 0) {
          const evt = eventQueue.shift()!;
          if (doneSentinel !== null && evt.data === doneSentinel) break;
          yield evt;
        }
        break;
      }
    }
  } catch (err) {
    if (err instanceof SSEConnectionError || err instanceof SSETimeoutError) {
      throw err;
    }
    throw new SSEConnectionError(
      err instanceof Error ? err.message : String(err),
    );
  } finally {
    reader.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// readNDJSONStream
// ---------------------------------------------------------------------------

/**
 * Consume a `fetch` Response whose body is newline-delimited JSON and
 * yield each parsed object.
 */
export async function* readNDJSONStream<T = unknown>(
  response: Response,
  options?: StreamReaderOptions,
): AsyncGenerator<T> {
  assertOkResponse(response);

  const { timeoutMs, signal } = resolveOptions(options);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();

  let valueQueue: T[] = [];

  const parser = new NDJSONParser<T>({
    onValue(value) {
      valueQueue.push(value);
    },
  });

  let lastActivity = Date.now();

  try {
    while (true) {
      if (signal?.aborted) {
        throw new SSEConnectionError('Stream aborted by caller');
      }
      if (timeoutMs > 0 && Date.now() - lastActivity > timeoutMs) {
        throw new SSETimeoutError(timeoutMs);
      }

      const result = await reader.read();

      if (result.value) {
        lastActivity = Date.now();
        const text = decoder.decode(result.value, { stream: true });
        parser.feed(text);
      }

      while (valueQueue.length > 0) {
        yield valueQueue.shift()!;
      }

      if (result.done) {
        const trailing = decoder.decode();
        if (trailing) parser.feed(trailing);
        parser.flush();

        while (valueQueue.length > 0) {
          yield valueQueue.shift()!;
        }
        break;
      }
    }
  } catch (err) {
    if (err instanceof SSEConnectionError || err instanceof SSETimeoutError) {
      throw err;
    }
    throw new SSEConnectionError(
      err instanceof Error ? err.message : String(err),
    );
  } finally {
    reader.releaseLock();
  }
}
