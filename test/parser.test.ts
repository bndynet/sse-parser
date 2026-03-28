import { describe, it, expect } from 'vitest';
import { SSEParser } from '../src/parser.js';
import type { SSEEvent } from '../src/types.js';

function collect(feed: (p: SSEParser) => void): SSEEvent[] {
  const events: SSEEvent[] = [];
  const parser = new SSEParser({ onEvent: (e) => events.push(e) });
  feed(parser);
  return events;
}

describe('SSEParser chunk boundaries', () => {
  it('joins a data field split across two chunks', () => {
    const events = collect((p) => {
      p.feed('data: hel');
      p.feed('lo\n\n');
    });
    expect(events).toHaveLength(1);
    expect(events[0].data).toBe('hello');
    expect(events[0].event).toBe('message');
  });

  it('handles a CRLF pair split across chunks without double-dispatching', () => {
    // "\r" ends "data: hello" in chunk 1; the following "\n" (chunk 2) is the
    // second half of the CRLF pair and must be skipped, then "\r\n" is the
    // blank line that dispatches the event.
    const events = collect((p) => {
      p.feed('data: hello\r');
      p.feed('\n\r\n');
    });
    expect(events).toHaveLength(1);
    expect(events[0].data).toBe('hello');
  });

  it('joins multi-line data with LF and strips the trailing LF', () => {
    const events = collect((p) => {
      p.feed('data: a\ndata: b\n\n');
    });
    expect(events).toHaveLength(1);
    expect(events[0].data).toBe('a\nb');
  });

  it('strips a single trailing LF for one-line data', () => {
    const events = collect((p) => {
      p.feed('data: x\n\n');
    });
    expect(events).toHaveLength(1);
    expect(events[0].data).toBe('x');
  });

  it('carries event type and id across the dispatch', () => {
    const events = collect((p) => {
      p.feed('event: ping\nid: 42\ndata: hi\n\n');
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ event: 'ping', id: '42', data: 'hi' });
  });

  it('does not dispatch an incomplete trailing event', () => {
    const events = collect((p) => {
      p.feed('data: partial\n'); // no terminating blank line
    });
    expect(events).toHaveLength(0);
  });

  it('preserves a leading empty data line (spec-faithful join)', () => {
    const events = collect((p) => {
      p.feed('data:\ndata:hello\n\n');
    });
    expect(events).toHaveLength(1);
    expect(events[0].data).toBe('\nhello');
  });

  it('dispatches an event for a single empty data line', () => {
    const events = collect((p) => {
      p.feed('data:\n\n');
    });
    expect(events).toHaveLength(1);
    expect(events[0].data).toBe('');
  });
});

describe('SSEParser retry handling', () => {
  it('surfaces retry via onRetry without producing a fake event', () => {
    const events: SSEEvent[] = [];
    const retries: number[] = [];
    const parser = new SSEParser({
      onEvent: (e) => events.push(e),
      onRetry: (ms) => retries.push(ms),
    });
    parser.feed('retry: 3000\n\n');

    expect(retries).toEqual([3000]);
    expect(events).toHaveLength(0);
  });

  it('attaches the retry hint to the next dispatched event', () => {
    const events = collect((p) => {
      p.feed('retry: 1500\ndata: hi\n\n');
    });
    expect(events).toHaveLength(1);
    expect(events[0].data).toBe('hi');
    expect(events[0].retry).toBe(1500);
  });

  it('ignores non-numeric retry values', () => {
    const retries: number[] = [];
    const parser = new SSEParser({
      onEvent: () => {},
      onRetry: (ms) => retries.push(ms),
    });
    parser.feed('retry: abc\n\n');
    expect(retries).toEqual([]);
  });
});
