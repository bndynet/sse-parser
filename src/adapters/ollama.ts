import type { ChatStreamEvent, StreamReaderOptions, TokenUsage } from '../types.js';
import { readNDJSONStream } from '../stream-reader.js';

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
  response: Response,
  options?: StreamReaderOptions,
): AsyncGenerator<ChatStreamEvent> {
  for await (const obj of readNDJSONStream<Record<string, unknown>>(response, options)) {
    // Error field
    if (typeof obj.error === 'string' && obj.error) {
      yield { type: 'error', message: obj.error };
      continue;
    }

    const msg = obj.message as Record<string, unknown> | undefined;

    if (msg) {
      // Text content
      if (typeof msg.content === 'string' && msg.content) {
        yield { type: 'text', content: msg.content };
      }

      // Some Ollama-compatible servers expose a `thinking` field
      if (typeof (msg as Record<string, unknown>).thinking === 'string') {
        const thinking = (msg as Record<string, unknown>).thinking as string;
        if (thinking) {
          yield { type: 'reasoning', content: thinking };
        }
      }
    }

    // Stream termination
    if (obj.done === true) {
      yield {
        type: 'done',
        usage: mapOllamaUsage(obj),
      };
      return;
    }
  }
}

function mapOllamaUsage(obj: Record<string, unknown>): TokenUsage | undefined {
  const prompt = obj.prompt_eval_count;
  const completion = obj.eval_count;
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
