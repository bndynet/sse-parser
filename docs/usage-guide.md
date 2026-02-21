# @bndynet/sse-parser Usage Guide

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Layer 1 — Low-level Parsers](#layer-1--low-level-parsers)
  - [SSEParser](#sseparser)
  - [NDJSONParser](#ndjsonparser)
- [Layer 2 — Stream Readers](#layer-2--stream-readers)
  - [readSSEStream](#readssestreamresponse-options)
  - [readNDJSONStream](#readndjsonstreamresponse-options)
  - [StreamReaderOptions](#streamreaderoptions)
- [Layer 3 — AI Adapters](#layer-3--ai-adapters)
  - [Unified ChatStreamEvent](#unified-chatstreamevent)
  - [OpenAI](#openai--openaistream)
  - [Anthropic](#anthropic--anthropicstream)
  - [Google Gemini](#google-gemini--geministream)
  - [Ollama](#ollama--ollamastream)
- [Error Handling](#error-handling)
- [Advanced Patterns](#advanced-patterns)
  - [AbortController cancellation](#abortcontroller-cancellation)
  - [Custom timeout](#custom-timeout)
  - [Custom SSE backends](#custom-sse-backends)
  - [Vue / React integration](#vue--react-integration)
- [API Reference Summary](#api-reference-summary)

---

## Architecture Overview

The SDK has three layers.  You can use any layer independently:

```
Layer 1 — Push Parsers (raw text → structured events)
  SSEParser          WHATWG-spec-compliant SSE parser
  NDJSONParser       Newline-delimited JSON parser

Layer 2 — Stream Readers (fetch Response → AsyncGenerator)
  readSSEStream      SSE events from a Response body
  readNDJSONStream   JSON objects from a Response body

Layer 3 — AI Adapters (vendor SSE → unified ChatStreamEvent)
  openaiStream       OpenAI / Azure / Groq / vLLM / LiteLLM
  anthropicStream    Anthropic Claude
  geminiStream       Google Gemini
  ollamaStream       Ollama (NDJSON)
```

Most users only need **Layer 3** (one import, one `for await` loop).

---

## Installation

```bash
npm install @bndynet/sse-parser
```

Zero runtime dependencies.  TypeScript types are included.

---

## Quick Start

```typescript
import { openaiStream } from '@bndynet/sse-parser';

const res = await fetch('https://api.openai.com/v1/chat/completions', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${OPENAI_API_KEY}`,
  },
  body: JSON.stringify({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: 'Hello!' }],
    stream: true,
  }),
});

for await (const event of openaiStream(res)) {
  switch (event.type) {
    case 'text':
      process.stdout.write(event.content);
      break;
    case 'reasoning':
      // o-series / DeepSeek thinking tokens
      process.stderr.write(event.content);
      break;
    case 'tool_call':
      console.log('Tool:', event.name, event.arguments);
      break;
    case 'error':
      console.error('API error:', event.message);
      break;
    case 'done':
      console.log('\nUsage:', event.usage);
      break;
  }
}
```

That's it.  The adapter handles `data: [DONE]`, JSON parsing, delta extraction, usage mapping, and error surfacing.

---

## Layer 1 — Low-level Parsers

Use these when you need full control over how bytes become events.

### SSEParser

A push-based state machine that implements the [WHATWG SSE parsing spec](https://html.spec.whatwg.org/multipage/server-sent-events.html#parsing-an-event-stream).

```typescript
import { SSEParser } from '@bndynet/sse-parser';

const parser = new SSEParser({
  onEvent(event) {
    // event: { event: string, data: string, id: string, retry?: number }
    console.log(event.event, event.data);
  },
  onComment(comment) {
    console.log('Comment:', comment);
  },
});

// Feed arbitrary text chunks — the parser handles partial lines,
// all line endings (CR, LF, CRLF), BOM, multi-line data, etc.
parser.feed('data: hello\n\n');
parser.feed('event: custom\ndata: world');
parser.feed('\n\n');

// Reuse the parser on a new stream
parser.reset();
```

**Key behaviors:**

| SSE input | `onEvent` receives |
|---|---|
| `data: hello\n\n` | `{ event: "message", data: "hello", id: "" }` |
| `data: line1\ndata: line2\n\n` | `{ event: "message", data: "line1\nline2", id: "" }` |
| `event: ping\ndata: {}\n\n` | `{ event: "ping", data: "{}", id: "" }` |
| `id: 42\ndata: x\n\n` | `{ event: "message", data: "x", id: "42" }` |
| `retry: 3000\n` | `{ event: "", data: "", id: "", retry: 3000 }` |
| `: keep-alive\n` | *onComment* `" keep-alive"` (no onEvent) |

### NDJSONParser

For APIs (like Ollama) that stream one JSON object per line instead of SSE.

```typescript
import { NDJSONParser } from '@bndynet/sse-parser';

const parser = new NDJSONParser<{ message: string; done: boolean }>({
  onValue(obj) {
    console.log(obj.message, obj.done);
  },
  onError(err, rawLine) {
    console.warn('Bad JSON line:', rawLine, err.message);
  },
});

parser.feed('{"message":"Hi","done":false}\n');
parser.feed('{"message":"!","done":true}\n');

// Call flush() at stream end to handle a final line without trailing newline
parser.flush();
```

---

## Layer 2 — Stream Readers

Wrap a `fetch` Response into an `AsyncGenerator` so you can `for await` over events.

### `readSSEStream(response, options?)`

```typescript
import { readSSEStream } from '@bndynet/sse-parser';

const res = await fetch('/my-sse-endpoint');

for await (const event of readSSEStream(res)) {
  console.log(event.event, event.data, event.id);
}
```

Returns `AsyncGenerator<SSEEvent>`.

The generator terminates when:

1. A `data` field equals the `doneSentinel` (default `"[DONE]"`)
2. The underlying ReadableStream signals `done`
3. The idle timeout expires (throws `SSETimeoutError`)
4. The caller's `AbortSignal` fires (throws `SSEConnectionError`)

### `readNDJSONStream<T>(response, options?)`

```typescript
import { readNDJSONStream } from '@bndynet/sse-parser';

const res = await fetch('/my-ndjson-endpoint');

for await (const obj of readNDJSONStream<MyType>(res)) {
  console.log(obj);
}
```

Returns `AsyncGenerator<T>`.

### StreamReaderOptions

```typescript
interface StreamReaderOptions {
  /**
   * Idle timeout in milliseconds.  If no data arrives within this window
   * an SSETimeoutError is thrown.
   * Default: 60000 (60 s).  Set 0 to disable.
   */
  timeoutMs?: number;

  /**
   * AbortSignal for external cancellation.
   * When aborted, the generator throws SSEConnectionError.
   */
  signal?: AbortSignal;

  /**
   * Sentinel string that ends the stream.
   * Default: "[DONE]" (OpenAI convention).
   * Set to null to disable (Anthropic, Gemini).
   */
  doneSentinel?: string | null;
}
```

---

## Layer 3 — AI Adapters

Each adapter takes a `fetch` Response and yields a unified `ChatStreamEvent`.

### Unified ChatStreamEvent

```typescript
type ChatStreamEvent =
  | { type: 'text'; content: string }
  | { type: 'reasoning'; content: string }
  | { type: 'tool_call'; id: string; name: string; arguments: string }
  | { type: 'error'; message: string; code?: string }
  | { type: 'done'; usage?: TokenUsage };

interface TokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}
```

All adapters share this same type — switch on `event.type` regardless of vendor.

---

### OpenAI — `openaiStream`

```typescript
import { openaiStream } from '@bndynet/sse-parser';
```

**Compatible with:** OpenAI, Azure OpenAI, Together AI, Groq, vLLM, LiteLLM, and any API that follows the OpenAI streaming response shape.

```typescript
const res = await fetch('https://api.openai.com/v1/chat/completions', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${key}`,
  },
  body: JSON.stringify({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: 'Explain SSE' }],
    stream: true,
    stream_options: { include_usage: true },
  }),
});

let fullText = '';

for await (const ev of openaiStream(res)) {
  if (ev.type === 'text')      fullText += ev.content;
  if (ev.type === 'reasoning') console.log('[think]', ev.content);
  if (ev.type === 'tool_call') console.log('[tool]', ev.name, ev.arguments);
  if (ev.type === 'error')     console.error(ev.message);
  if (ev.type === 'done')      console.log('Tokens:', ev.usage);
}
```

**What it handles internally:**

- `data: [DONE]` → terminates the generator
- `choices[0].delta.content` → `{ type: 'text' }`
- `choices[0].delta.reasoning_content` → `{ type: 'reasoning' }`
- `choices[0].delta.tool_calls` → `{ type: 'tool_call' }` per tool
- `usage` on the final chunk → `{ type: 'done', usage }` with mapped field names
- API `error` objects → `{ type: 'error' }`

---

### Anthropic — `anthropicStream`

```typescript
import { anthropicStream } from '@bndynet/sse-parser';
```

```typescript
const res = await fetch('https://api.anthropic.com/v1/messages', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-api-key': key,
    'anthropic-version': '2023-06-01',
  },
  body: JSON.stringify({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1024,
    messages: [{ role: 'user', content: 'Hello Claude' }],
    stream: true,
  }),
});

for await (const ev of anthropicStream(res)) {
  if (ev.type === 'text')      process.stdout.write(ev.content);
  if (ev.type === 'reasoning') process.stderr.write(ev.content);
  if (ev.type === 'tool_call') console.log('[tool]', ev.name);
  if (ev.type === 'done')      console.log('Usage:', ev.usage);
}
```

**What it handles internally:**

- `event: content_block_delta` + `delta.type: "text_delta"` → `{ type: 'text' }`
- `event: content_block_delta` + `delta.type: "thinking_delta"` → `{ type: 'reasoning' }`
- `event: content_block_start` with `tool_use` → `{ type: 'tool_call' }` (id + name)
- `event: content_block_delta` + `delta.type: "input_json_delta"` → `{ type: 'tool_call' }` (incremental args)
- `event: message_delta` with `stop_reason` → `{ type: 'done', usage }`
- `event: message_stop` → `{ type: 'done' }` and generator returns
- `event: error` → `{ type: 'error' }`
- `event: ping` → silently ignored

Note: the adapter internally sets `doneSentinel: null` since Anthropic does not use `data: [DONE]`.

---

### Google Gemini — `geminiStream`

```typescript
import { geminiStream } from '@bndynet/sse-parser';
```

```typescript
const url =
  `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash` +
  `:streamGenerateContent?alt=sse&key=${key}`;

const res = await fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    contents: [{ parts: [{ text: 'Hello Gemini' }] }],
  }),
});

for await (const ev of geminiStream(res)) {
  if (ev.type === 'text')      process.stdout.write(ev.content);
  if (ev.type === 'tool_call') console.log('[fn]', ev.name, ev.arguments);
  if (ev.type === 'done')      console.log('Usage:', ev.usage);
}
```

**What it handles internally:**

- `candidates[0].content.parts[*].text` → `{ type: 'text' }`
- `candidates[0].content.parts[*].functionCall` → `{ type: 'tool_call' }`
- `finishReason` → `{ type: 'done' }`
- `usageMetadata` → `TokenUsage` with `promptTokenCount`, `candidatesTokenCount`, `totalTokenCount`
- No `[DONE]` sentinel — stream ends when connection closes

---

### Ollama — `ollamaStream`

```typescript
import { ollamaStream } from '@bndynet/sse-parser';
```

```typescript
const res = await fetch('http://localhost:11434/api/chat', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model: 'llama3',
    messages: [{ role: 'user', content: 'Hello Llama' }],
  }),
});

for await (const ev of ollamaStream(res)) {
  if (ev.type === 'text')      process.stdout.write(ev.content);
  if (ev.type === 'reasoning') process.stderr.write(ev.content);
  if (ev.type === 'done')      console.log('Usage:', ev.usage);
}
```

**What it handles internally:**

- Uses `readNDJSONStream` (not SSE) since Ollama streams line-delimited JSON
- `message.content` → `{ type: 'text' }`
- `message.thinking` → `{ type: 'reasoning' }` (some Ollama-compatible servers)
- `done: true` → `{ type: 'done' }` with usage from `prompt_eval_count` / `eval_count`
- `error` field → `{ type: 'error' }`

---

## Error Handling

The SDK defines a typed error hierarchy:

```
SSEError (base)
├── SSEParseError      — malformed SSE line or invalid JSON (non-fatal in adapters)
├── SSEConnectionError — network failure, HTTP error, abort
└── SSETimeoutError    — idle timeout exceeded
```

### Catching errors

```typescript
import {
  openaiStream,
  SSEConnectionError,
  SSETimeoutError,
} from '@bndynet/sse-parser';

try {
  for await (const ev of openaiStream(res)) {
    // ...
  }
} catch (err) {
  if (err instanceof SSETimeoutError) {
    console.error(`Stream timed out after ${err.timeoutMs}ms`);
  } else if (err instanceof SSEConnectionError) {
    console.error(`Connection error (HTTP ${err.status}):`, err.message);
  } else {
    throw err;
  }
}
```

### Fatal vs non-fatal

| Error type | Fatal? | Behavior |
|---|---|---|
| `SSEConnectionError` | Yes | Generator throws, `for await` exits |
| `SSETimeoutError` | Yes | Generator throws, `for await` exits |
| Bad JSON in one SSE `data:` line | No | Adapter yields `{ type: 'error' }`, continues |
| HTTP non-2xx response | Yes | `readSSEStream` throws `SSEConnectionError` immediately |
| `AbortSignal` aborted | Yes | Generator throws `SSEConnectionError` |

---

## Advanced Patterns

### AbortController cancellation

```typescript
const controller = new AbortController();

// Cancel after 10 seconds
setTimeout(() => controller.abort(), 10_000);

try {
  for await (const ev of openaiStream(res, { signal: controller.signal })) {
    // ...
  }
} catch (err) {
  if (err instanceof SSEConnectionError && err.message.includes('aborted')) {
    console.log('Stream was cancelled');
  }
}
```

### Custom timeout

```typescript
// 2 minute timeout
for await (const ev of openaiStream(res, { timeoutMs: 120_000 })) { /* ... */ }

// No timeout
for await (const ev of openaiStream(res, { timeoutMs: 0 })) { /* ... */ }
```

### Custom SSE backends

If your backend sends SSE but doesn't match any vendor format, use `readSSEStream` directly:

```typescript
import { readSSEStream } from '@bndynet/sse-parser';

const res = await fetch('/api/my-custom-stream', { method: 'POST', body: '...' });

for await (const sse of readSSEStream(res, { doneSentinel: '[DONE]' })) {
  // sse.event — event type (default "message")
  // sse.data  — the data payload string
  // sse.id    — event ID

  const payload = JSON.parse(sse.data);
  // ... your custom logic
}
```

If your backend doesn't use `[DONE]`, set `doneSentinel: null`:

```typescript
for await (const sse of readSSEStream(res, { doneSentinel: null })) {
  // Stream ends when the connection closes
}
```

### Vue / React integration

The SDK is framework-agnostic.  Here is how it's used in the sse-parser Vue app:

```javascript
import { readSSEStream, ollamaStream } from '@bndynet/sse-parser';

// Demo backend — custom SSE format
for await (const sse of readSSEStream(res, { timeoutMs: 60000 })) {
  const data = JSON.parse(sse.data);
  if (data.content) {
    assistant.content += data.content;   // reactive Vue ref
    await nextTick();                     // flush DOM update
  }
}

// Ollama backend — use the adapter directly
for await (const event of ollamaStream(res, { timeoutMs: 60000 })) {
  if (event.type === 'text') {
    assistant.content += event.content;
    await nextTick();
  }
}
```

For React, replace `nextTick()` with a state setter:

```tsx
const [text, setText] = useState('');

for await (const ev of openaiStream(res)) {
  if (ev.type === 'text') {
    setText(prev => prev + ev.content);
  }
}
```

---

## API Reference Summary

### Exports

| Export | Layer | Description |
|---|---|---|
| `SSEParser` | 1 | Push-based SSE parser — `feed(chunk)` / `reset()` |
| `NDJSONParser` | 1 | Push-based NDJSON parser — `feed(chunk)` / `flush()` / `reset()` |
| `readSSEStream(res, opts?)` | 2 | `AsyncGenerator<SSEEvent>` from fetch Response |
| `readNDJSONStream<T>(res, opts?)` | 2 | `AsyncGenerator<T>` from fetch Response |
| `openaiStream(res, opts?)` | 3 | OpenAI adapter → `AsyncGenerator<ChatStreamEvent>` |
| `anthropicStream(res, opts?)` | 3 | Anthropic adapter → `AsyncGenerator<ChatStreamEvent>` |
| `geminiStream(res, opts?)` | 3 | Gemini adapter → `AsyncGenerator<ChatStreamEvent>` |
| `ollamaStream(res, opts?)` | 3 | Ollama adapter → `AsyncGenerator<ChatStreamEvent>` |

### Types

| Type | Description |
|---|---|
| `SSEEvent` | `{ event, data, id, retry? }` |
| `ChatStreamEvent` | Discriminated union: `text \| reasoning \| tool_call \| error \| done` |
| `TokenUsage` | `{ promptTokens?, completionTokens?, totalTokens? }` |
| `StreamReaderOptions` | `{ timeoutMs?, signal?, doneSentinel? }` |
| `SSEParserCallbacks` | `{ onEvent, onComment?, onError? }` |
| `NDJSONParserCallbacks<T>` | `{ onValue, onError? }` |

### Errors

| Error class | When thrown |
|---|---|
| `SSEError` | Base class (not thrown directly) |
| `SSEParseError` | Malformed SSE line or invalid JSON (via callback, non-fatal) |
| `SSEConnectionError` | Network failure, HTTP non-2xx, abort |
| `SSETimeoutError` | Idle timeout exceeded |
