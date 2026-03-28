import type { SSEEvent, StreamInput, StreamReaderOptions } from './types.js';
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
// ChunkSource — a uniform pull interface over the supported input kinds
// ---------------------------------------------------------------------------

/** A single chunk of the stream; `value` is undefined once `done` is true. */
interface ReadOutcome {
  value: Uint8Array | string | undefined;
  done: boolean;
}

/**
 * Normalizes the three accepted input kinds (`Response`, `ReadableStream`,
 * `AsyncIterable`) behind one pull-based interface so the read loop and the
 * deadline/abort machinery don't have to special-case them.
 */
interface ChunkSource {
  /** Pull the next chunk. */
  next(): Promise<ReadOutcome>;
  /** Proactively tear down the source (on timeout / abort / error). */
  cancel(): void;
  /** Release any held resources after normal iteration completes. */
  release(): void;
}

function isReadableStream(x: unknown): x is ReadableStream<Uint8Array> {
  return typeof (x as { getReader?: unknown } | null)?.getReader === 'function';
}

function isResponse(x: unknown): x is Response {
  return (
    typeof x === 'object' &&
    x !== null &&
    'body' in x &&
    'status' in x &&
    typeof (x as { status?: unknown }).status === 'number'
  );
}

function isAsyncIterable(
  x: unknown,
): x is AsyncIterable<Uint8Array | string> {
  return (
    typeof (x as { [Symbol.asyncIterator]?: unknown } | null)?.[
      Symbol.asyncIterator
    ] === 'function'
  );
}

/** Wrap a Web `ReadableStreamDefaultReader` as a {@link ChunkSource}. */
function readerSource(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): ChunkSource {
  return {
    next: () => reader.read(),
    cancel: () => {
      // Release the underlying connection; ignore cancel rejections.
      void reader.cancel().catch(() => {});
    },
    release: () => {
      try {
        reader.releaseLock();
      } catch {
        // A pending read (e.g. after cancel on timeout/abort) makes releaseLock
        // throw — safe to ignore since the stream is already being torn down.
      }
    },
  };
}

/** Wrap any `AsyncIterable` as a {@link ChunkSource}. */
function asyncIterableSource(
  iterable: AsyncIterable<Uint8Array | string>,
): ChunkSource {
  const iterator = iterable[Symbol.asyncIterator]();
  // Best-effort early termination; ignore errors / absent `return`. Calling
  // `return()` runs the source generator's `finally` (e.g. so an upstream
  // HttpClient subscription is unsubscribed) — both on cancel and on early
  // termination via `[DONE]`, where the source is never drained to completion.
  const end = (): void => {
    try {
      void Promise.resolve(iterator.return?.()).catch(() => {});
    } catch {
      // ignore
    }
  };
  return {
    next: () =>
      iterator.next().then((r) => ({ value: r.value, done: Boolean(r.done) })),
    cancel: end,
    release: end,
  };
}

/**
 * Resolve a {@link StreamInput} into a {@link ChunkSource}.
 *
 * For a `Response`, the HTTP status is validated first (non-2xx throws
 * `SSEConnectionError`); raw `ReadableStream`/`AsyncIterable` inputs skip that
 * check since they carry no transport metadata.
 */
function toChunkSource(input: StreamInput): ChunkSource {
  // ReadableStream first: a Response is NOT a ReadableStream (no getReader),
  // and a ReadableStream is also async-iterable in modern runtimes, so it must
  // be matched before the AsyncIterable branch.
  if (isReadableStream(input)) {
    return readerSource(input.getReader());
  }
  if (isResponse(input)) {
    assertOkResponse(input);
    return readerSource(input.body!.getReader());
  }
  if (isAsyncIterable(input)) {
    return asyncIterableSource(input);
  }
  throw new SSEConnectionError(
    'Unsupported stream input: expected a Response, ReadableStream, or AsyncIterable',
  );
}

/**
 * Pull the next chunk, racing `source.next()` against an idle-timeout timer
 * and an external `AbortSignal`.
 *
 * Unlike a top-of-loop check, this guarantees the timeout and abort take
 * effect even while the underlying read is blocked waiting for data (e.g. a
 * hung server that never sends another byte). When either fires we proactively
 * cancel the source to tear down the underlying connection.
 */
function readWithDeadline(
  source: ChunkSource,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<ReadOutcome> {
  if (signal?.aborted) {
    source.cancel();
    return Promise.reject(new SSEConnectionError('Stream aborted by caller'));
  }

  // Fast path: nothing to race against.
  if (timeoutMs <= 0 && !signal) {
    return source.next();
  }

  return new Promise<ReadOutcome>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };

    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      source.cancel();
      reject(err);
    };

    function onAbort(): void {
      fail(new SSEConnectionError('Stream aborted by caller'));
    }

    if (timeoutMs > 0) {
      timer = setTimeout(() => fail(new SSETimeoutError(timeoutMs)), timeoutMs);
    }
    signal?.addEventListener('abort', onAbort, { once: true });

    source.next().then(
      (result) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      },
      (err: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

/** Turn a raw chunk into text; pass strings through, decode bytes. */
function decodeChunk(
  decoder: TextDecoder,
  value: Uint8Array | string,
): string {
  return typeof value === 'string' ? value : decoder.decode(value, { stream: true });
}

// ---------------------------------------------------------------------------
// readSSEStream
// ---------------------------------------------------------------------------

/**
 * Consume an SSE (`text/event-stream`) source and yield parsed
 * {@link SSEEvent} objects.
 *
 * Accepts a `fetch` {@link Response}, a raw `ReadableStream<Uint8Array>`, or
 * any `AsyncIterable` of byte/text chunks (see {@link StreamInput}).
 *
 * The generator terminates when:
 *   1. A `data` field equals the configured `doneSentinel` (default `[DONE]`).
 *   2. The underlying source signals `done`.
 *   3. The idle timeout expires.
 *   4. The caller's `AbortSignal` fires.
 */
export async function* readSSEStream(
  input: StreamInput,
  options?: StreamReaderOptions,
): AsyncGenerator<SSEEvent> {
  const { timeoutMs, signal, doneSentinel } = resolveOptions(options);
  const source = toChunkSource(input);
  const decoder = new TextDecoder();

  // Queue for events produced by the push parser
  const eventQueue: SSEEvent[] = [];
  let done = false;

  const parser = new SSEParser({
    onEvent(evt) {
      eventQueue.push(evt);
    },
  });

  try {
    while (!done) {
      const result = await readWithDeadline(source, timeoutMs, signal);

      if (result.value !== undefined) {
        parser.feed(decodeChunk(decoder, result.value));
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
    source.release();
  }
}

// ---------------------------------------------------------------------------
// readNDJSONStream
// ---------------------------------------------------------------------------

/**
 * Consume a newline-delimited JSON source and yield each parsed object.
 *
 * Accepts a `fetch` {@link Response}, a raw `ReadableStream<Uint8Array>`, or
 * any `AsyncIterable` of byte/text chunks (see {@link StreamInput}).
 */
export async function* readNDJSONStream<T = unknown>(
  input: StreamInput,
  options?: StreamReaderOptions,
): AsyncGenerator<T> {
  const { timeoutMs, signal } = resolveOptions(options);
  const source = toChunkSource(input);
  const decoder = new TextDecoder();

  const valueQueue: T[] = [];

  const parser = new NDJSONParser<T>({
    onValue(value) {
      valueQueue.push(value);
    },
  });

  try {
    while (true) {
      const result = await readWithDeadline(source, timeoutMs, signal);

      if (result.value !== undefined) {
        parser.feed(decodeChunk(decoder, result.value));
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
    source.release();
  }
}
