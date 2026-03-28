import { describe, it, expect } from 'vitest';
import { readSSEStream } from '../src/stream-reader.js';
import { SSEConnectionError, SSETimeoutError } from '../src/errors.js';
import type { SSEEvent } from '../src/types.js';

const enc = new TextEncoder();

function sseResponse(stream: ReadableStream<Uint8Array>): Response {
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

async function collect(gen: AsyncGenerator<SSEEvent>): Promise<SSEEvent[]> {
  const out: SSEEvent[] = [];
  for await (const v of gen) out.push(v);
  return out;
}

describe('readSSEStream happy path', () => {
  it('yields events from multiple chunks and stops at [DONE]', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode('data: a\n\n'));
        controller.enqueue(enc.encode('data: b\n\n'));
        controller.enqueue(enc.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });

    const events = await collect(readSSEStream(sseResponse(stream)));
    expect(events.map((e) => e.data)).toEqual(['a', 'b']);
  });

  it('detects the [DONE] sentinel even when split across chunks', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode('data: hi\n\ndata: [DON'));
        controller.enqueue(enc.encode('E]\n\n'));
        controller.close();
      },
    });

    const events = await collect(readSSEStream(sseResponse(stream)));
    expect(events.map((e) => e.data)).toEqual(['hi']);
  });
});

describe('readSSEStream input kinds', () => {
  it('accepts a raw ReadableStream<Uint8Array> directly', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode('data: a\n\n'));
        controller.enqueue(enc.encode('data: b\n\n'));
        controller.close();
      },
    });

    const events = await collect(readSSEStream(stream));
    expect(events.map((e) => e.data)).toEqual(['a', 'b']);
  });

  it('accepts an AsyncIterable of strings (e.g. a test stub)', async () => {
    async function* gen(): AsyncGenerator<string> {
      yield 'data: hel';
      yield 'lo\n\n';
      yield 'data: [DONE]\n\n';
    }

    const events = await collect(readSSEStream(gen()));
    expect(events.map((e) => e.data)).toEqual(['hello']);
  });

  it('accepts an AsyncIterable of Uint8Array chunks (e.g. a Node stream)', async () => {
    async function* gen(): AsyncGenerator<Uint8Array> {
      yield enc.encode('data: one\n\n');
      yield enc.encode('data: two\n\n');
    }

    const events = await collect(readSSEStream(gen()));
    expect(events.map((e) => e.data)).toEqual(['one', 'two']);
  });

  it('still validates HTTP status for Response inputs', async () => {
    const res = new Response('nope', { status: 500, statusText: 'Server Error' });
    await expect(collect(readSSEStream(res))).rejects.toBeInstanceOf(
      SSEConnectionError,
    );
  });

  it('throws SSEConnectionError for an unsupported input', async () => {
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      collect(readSSEStream({ not: 'a stream' } as any)),
    ).rejects.toBeInstanceOf(SSEConnectionError);
  });

  it('calls iterator.return() on abort for an AsyncIterable source', async () => {
    let returned = false;
    const controller = new AbortController();

    const iterable: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return {
          next() {
            // Never resolves until aborted.
            return new Promise<IteratorResult<Uint8Array>>(() => {});
          },
          return() {
            returned = true;
            return Promise.resolve({ value: undefined, done: true });
          },
        };
      },
    };

    setTimeout(() => controller.abort(), 20);

    await expect(
      collect(readSSEStream(iterable, { signal: controller.signal, timeoutMs: 0 })),
    ).rejects.toThrow('Stream aborted by caller');

    expect(returned).toBe(true);
  });
});

describe('readSSEStream idle timeout', () => {
  it('rejects with SSETimeoutError when the stream never sends data', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });

    await expect(
      collect(readSSEStream(sseResponse(stream), { timeoutMs: 20 })),
    ).rejects.toBeInstanceOf(SSETimeoutError);

    // The underlying stream must be torn down.
    expect(cancelled).toBe(true);
  });
});

describe('readSSEStream abort', () => {
  it('rejects promptly while a read is pending and cancels the stream', async () => {
    let cancelled = false;
    const controller = new AbortController();
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });

    setTimeout(() => controller.abort(), 20);

    await expect(
      collect(
        readSSEStream(sseResponse(stream), {
          signal: controller.signal,
          timeoutMs: 0,
        }),
      ),
    ).rejects.toThrow('Stream aborted by caller');

    expect(cancelled).toBe(true);
  });

  it('throws SSEConnectionError when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode('data: a\n\n'));
        c.close();
      },
    });

    await expect(
      collect(
        readSSEStream(sseResponse(stream), { signal: controller.signal }),
      ),
    ).rejects.toBeInstanceOf(SSEConnectionError);
  });
});
