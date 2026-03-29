import type { ChatStreamEvent, StreamInput, StreamReaderOptions, TokenUsage } from '../types.js';
import { readNDJSONStream } from '../stream-reader.js';
import { numberField } from './usage.js';

/**
 * Ollama `/api/chat` streaming adapter.
 *
 * Ollama uses **NDJSON** (one JSON object per line), not SSE:
 *
 *   {"model":"llama3","message":{"role":"assistant","content":"Hi"},"done":false}
 *   {"model":"llama3","message":{"role":"assistant","content":"!"},"done":true, ...}
 *
 * The final object has `done: true` and optionally carries eval timing metrics
 * which we map to a simplified {@link TokenUsage}.
 */
export async function* ollamaStream(
  input: StreamInput,
  options?: StreamReaderOptions,
): AsyncGenerator<ChatStreamEvent> {
  for await (const obj of readNDJSONStream<Record<string, unknown>>(input, options)) {
    // Error field
    if (typeof obj.error === 'string' && obj.error) {
      yield { type: 'error', message: obj.error, raw: obj };
      continue;
    }

    const msg = obj.message as Record<string, unknown> | undefined;

    if (msg) {
      // Text content
      if (typeof msg.content === 'string' && msg.content) {
        yield { type: 'text', content: msg.content, raw: obj };
      }

      // Some Ollama-compatible servers expose a `thinking` field
      if (typeof (msg as Record<string, unknown>).thinking === 'string') {
        const thinking = (msg as Record<string, unknown>).thinking as string;
        if (thinking) {
          yield { type: 'reasoning', content: thinking, raw: obj };
        }
      }
    }

    // Stream termination
    if (obj.done === true) {
      yield {
        type: 'done',
        usage: mapOllamaUsage(obj),
        finishReason: typeof obj.done_reason === 'string' ? obj.done_reason : undefined,
        raw: obj,
      };
      return;
    }
  }
}

function mapOllamaUsage(obj: Record<string, unknown>): TokenUsage | undefined {
  const prompt = numberField(obj, 'prompt_eval_count');
  const completion = numberField(obj, 'eval_count');
  if (typeof prompt !== 'number' && typeof completion !== 'number') {
    return undefined;
  }
  return {
    promptTokens: typeof prompt === 'number' ? prompt : undefined,
    completionTokens: typeof completion === 'number' ? completion : undefined,
    totalTokens:
      typeof prompt === 'number' && typeof completion === 'number'
        ? prompt + completion
        : undefined,
  };
}
