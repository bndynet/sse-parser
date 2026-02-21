import type { ChatStreamEvent, StreamReaderOptions, TokenUsage } from '../types.js';
import { readSSEStream } from '../stream-reader.js';

/**
 * OpenAI-compatible streaming adapter.
 *
 * Handles the `POST /v1/chat/completions` SSE format:
 *   - `data: {"choices":[{"delta":{"content":"..."}}]}`
 *   - `data: {"choices":[{"delta":{"reasoning_content":"..."}}]}`
 *   - `data: {"choices":[{"delta":{"tool_calls":[...]}}]}`
 *   - `data: [DONE]`
 *
 * Also works with any API that follows the OpenAI response shape
 * (e.g. Azure OpenAI, Together AI, Groq, vLLM, LiteLLM).
 */
export async function* openaiStream(
  response: Response,
  options?: StreamReaderOptions,
): AsyncGenerator<ChatStreamEvent> {
  for await (const sse of readSSEStream(response, options)) {
    // Skip empty data or retry-only events
    if (!sse.data) continue;

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(sse.data);
    } catch {
      yield { type: 'error', message: 'Invalid JSON in SSE data', code: 'parse_error' };
      continue;
    }

    // Error object from the API
    if (payload.error) {
      const err = payload.error as Record<string, unknown>;
      yield {
        type: 'error',
        message: String(err.message ?? 'Unknown OpenAI error'),
        code: err.code != null ? String(err.code) : undefined,
      };
      continue;
    }

    const choices = payload.choices as Array<Record<string, unknown>> | undefined;
    if (!choices || choices.length === 0) {
      // Final chunk may carry only `usage`
      if (payload.usage) {
        yield { type: 'done', usage: mapUsage(payload.usage) };
      }
      continue;
    }

    const choice = choices[0];
    const delta = choice.delta as Record<string, unknown> | undefined;

    if (!delta) {
      if (choice.finish_reason) {
        yield { type: 'done', usage: payload.usage ? mapUsage(payload.usage) : undefined };
      }
      continue;
    }

    // Text content
    if (typeof delta.content === 'string' && delta.content) {
      yield { type: 'text', content: delta.content };
    }

    // Reasoning / thinking content (OpenAI o-series, DeepSeek-R1, etc.)
    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
      yield { type: 'reasoning', content: delta.reasoning_content };
    }

    // Tool calls
    const toolCalls = delta.tool_calls as Array<Record<string, unknown>> | undefined;
    if (toolCalls) {
      for (const tc of toolCalls) {
        const fn = tc.function as Record<string, unknown> | undefined;
        if (fn) {
          yield {
            type: 'tool_call',
            id: String(tc.id ?? ''),
            name: String(fn.name ?? ''),
            arguments: String(fn.arguments ?? ''),
          };
        }
      }
    }

    // Finish reason in this chunk
    if (choice.finish_reason) {
      yield { type: 'done', usage: payload.usage ? mapUsage(payload.usage) : undefined };
    }
  }
}

function mapUsage(raw: unknown): TokenUsage {
  const u = raw as Record<string, unknown>;
  return {
    promptTokens: typeof u.prompt_tokens === 'number' ? u.prompt_tokens : undefined,
    completionTokens: typeof u.completion_tokens === 'number' ? u.completion_tokens : undefined,
    totalTokens: typeof u.total_tokens === 'number' ? u.total_tokens : undefined,
  };
}
