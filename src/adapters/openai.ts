import type { ChatStreamEvent, StreamInput, StreamReaderOptions, TokenUsage } from '../types.js';
import { readSSEStream } from '../stream-reader.js';
import { addNumber, asRecord, numberField } from './usage.js';

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
  input: StreamInput,
  options?: StreamReaderOptions,
): AsyncGenerator<ChatStreamEvent> {
  // Accumulate usage across chunks and emit exactly one terminal `done`
  // when the stream completes (avoids duplicate done events from a
  // finish_reason chunk plus a trailing usage-only chunk).
  let usage: TokenUsage | undefined;
  let finishReason: string | undefined;
  let lastPayload: unknown;

  for await (const sse of readSSEStream(input, options)) {
    // Skip empty data or retry-only events
    if (!sse.data) continue;

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(sse.data);
    } catch {
      yield { type: 'error', message: 'Invalid JSON in SSE data', code: 'parse_error' };
      continue;
    }
    lastPayload = payload;

    // Error object from the API
    if (payload.error) {
      const err = payload.error as Record<string, unknown>;
      yield {
        type: 'error',
        message: String(err.message ?? 'Unknown OpenAI error'),
        code: err.code != null ? String(err.code) : undefined,
        raw: payload,
      };
      continue;
    }

    // Usage may arrive on any chunk (typically the final one when
    // `stream_options: { include_usage: true }`).
    if (payload.usage) {
      usage = mapUsage(payload.usage);
    }

    const choices = payload.choices as Array<Record<string, unknown>> | undefined;
    if (!choices || choices.length === 0) {
      continue;
    }

    const choice = choices[0];
    if (typeof choice.finish_reason === 'string') {
      finishReason = choice.finish_reason;
    }

    const delta = choice.delta as Record<string, unknown> | undefined;
    if (!delta) {
      continue;
    }

    // Text content
    if (typeof delta.content === 'string' && delta.content) {
      yield { type: 'text', content: delta.content, raw: payload };
    }

    // Reasoning / thinking content (OpenAI o-series, DeepSeek-R1, etc.)
    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
      yield { type: 'reasoning', content: delta.reasoning_content, raw: payload };
    }

    // Tool calls — fragments are grouped by `index` so callers can
    // reassemble parallel/streamed tool calls.
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
            index: typeof tc.index === 'number' ? tc.index : undefined,
            raw: payload,
          };
        }
      }
    }
  }

  yield { type: 'done', usage, finishReason, raw: lastPayload };
}

function mapUsage(raw: unknown): TokenUsage {
  const u = asRecord(raw);
  const promptDetails = asRecord(u?.prompt_tokens_details);
  const completionDetails = asRecord(u?.completion_tokens_details);
  const promptTokens = numberField(u, 'prompt_tokens');
  const cachedPromptTokens =
    numberField(u, 'prompt_cache_hit_tokens') ??
    numberField(promptDetails, 'cached_tokens');

  const usage: TokenUsage = {
    promptTokens,
    completionTokens: numberField(u, 'completion_tokens'),
    totalTokens: numberField(u, 'total_tokens'),
  };

  addNumber(usage, 'cachedPromptTokens', cachedPromptTokens);
  addNumber(usage, 'uncachedPromptTokens', numberField(u, 'prompt_cache_miss_tokens'));
  if (
    usage.uncachedPromptTokens === undefined &&
    promptTokens !== undefined &&
    cachedPromptTokens !== undefined
  ) {
    usage.uncachedPromptTokens = promptTokens - cachedPromptTokens;
  }
  addNumber(usage, 'reasoningTokens', numberField(completionDetails, 'reasoning_tokens'));

  return usage;
}
