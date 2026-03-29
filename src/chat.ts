import type { ChatStreamEvent, StreamInput, StreamReaderOptions } from './types.js';
import { openaiStream } from './adapters/openai.js';
import { openaiResponsesStream } from './adapters/openai-responses.js';
import { deepseekStream } from './adapters/deepseek.js';
import { anthropicStream } from './adapters/anthropic.js';
import { geminiStream } from './adapters/gemini.js';
import { ollamaStream } from './adapters/ollama.js';

/** Supported AI providers for the unified {@link chatStream} entry point. */
export type ChatProvider =
  | 'openai'
  | 'openai-responses'
  | 'deepseek'
  | 'anthropic'
  | 'gemini'
  | 'ollama';

export interface ChatStreamOptions extends StreamReaderOptions {
  /** Which vendor adapter to use. */
  provider: ChatProvider;
}

/**
 * Unified entry point — dispatch a stream source to the matching vendor
 * adapter based on `options.provider`, yielding the normalized
 * {@link ChatStreamEvent} stream.
 *
 * The `input` may be a `fetch` Response, a raw `ReadableStream<Uint8Array>`,
 * or any `AsyncIterable` of byte/text chunks (see {@link StreamInput}).
 *
 * ```typescript
 * for await (const ev of chatStream(res, { provider: 'openai' })) {
 *   if (ev.type === 'text') process.stdout.write(ev.content);
 * }
 * ```
 *
 * Pick the explicit adapter (e.g. {@link openaiStream}) directly when you
 * already know the vendor and prefer not to pass `provider`.
 */
export function chatStream(
  input: StreamInput,
  options: ChatStreamOptions,
): AsyncGenerator<ChatStreamEvent> {
  switch (options.provider) {
    case 'openai':
      return openaiStream(input, options);
    case 'openai-responses':
      return openaiResponsesStream(input, options);
    case 'deepseek':
      return deepseekStream(input, options);
    case 'anthropic':
      return anthropicStream(input, options);
    case 'gemini':
      return geminiStream(input, options);
    case 'ollama':
      return ollamaStream(input, options);
    default: {
      // Exhaustiveness guard — TS errors here if a provider is unhandled.
      const exhaustive: never = options.provider;
      throw new Error(`Unknown chat provider: ${String(exhaustive)}`);
    }
  }
}
