import type { ChatStreamEvent, StreamInput, StreamReaderOptions, TokenUsage } from '../types.js';
import { readSSEStream } from '../stream-reader.js';
import { addNumber, asRecord, numberField } from './usage.js';

/**
 * OpenAI Responses API streaming adapter (`POST /v1/responses` with `stream: true`).
 *
 * The Responses API uses semantic SSE events (the `event:` field carries the
 * type, which is mirrored in the JSON `data` payload's `type` field) and does
 * NOT terminate with `data: [DONE]` — it ends with a `response.completed`
 * event. Notable events:
 *
 *   response.output_text.delta             → incremental assistant text
 *   response.reasoning_text.delta          → incremental reasoning text
 *   response.reasoning_summary_text.delta  → incremental reasoning summary
 *   response.output_item.added             → start of an output item (e.g. function_call)
 *   response.function_call_arguments.delta → incremental tool-call arguments
 *   response.completed                     → terminal event carrying usage
 *   response.failed / response.incomplete  → terminal error
 *   error                                  → stream-level error
 *
 * This is distinct from the older Chat Completions format handled by
 * {@link openaiStream}; pick the adapter that matches the endpoint you call.
 */
export async function* openaiResponsesStream(
  input: StreamInput,
  options?: StreamReaderOptions,
): AsyncGenerator<ChatStreamEvent> {
  // Responses API has no `[DONE]` sentinel.
  const opts: StreamReaderOptions = { ...options, doneSentinel: null };

  let usage: TokenUsage | undefined;

  for await (const sse of readSSEStream(input, opts)) {
    if (!sse.data) continue;

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(sse.data);
    } catch {
      yield { type: 'error', message: 'Invalid JSON in Responses SSE', code: 'parse_error' };
      continue;
    }

    // Prefer the SSE `event:` type, falling back to the payload `type` field.
    const type = String(sse.event || payload.type || '');
    const outputIndex =
      typeof payload.output_index === 'number' ? payload.output_index : undefined;

    switch (type) {
      case 'response.output_text.delta': {
        if (typeof payload.delta === 'string' && payload.delta) {
          yield { type: 'text', content: payload.delta, raw: payload };
        }
        break;
      }

      case 'response.reasoning_text.delta':
      case 'response.reasoning_summary_text.delta': {
        if (typeof payload.delta === 'string' && payload.delta) {
          yield { type: 'reasoning', content: payload.delta, raw: payload };
        }
        break;
      }

      case 'response.output_item.added': {
        const item = payload.item as Record<string, unknown> | undefined;
        if (item?.type === 'function_call') {
          yield {
            type: 'tool_call',
            id: String(item.call_id ?? item.id ?? ''),
            name: String(item.name ?? ''),
            arguments: '',
            index: outputIndex,
            raw: payload,
          };
        }
        break;
      }

      case 'response.function_call_arguments.delta': {
        if (typeof payload.delta === 'string') {
          yield {
            type: 'tool_call',
            id: String(payload.item_id ?? ''),
            name: '',
            arguments: payload.delta,
            index: outputIndex,
            raw: payload,
          };
        }
        break;
      }

      case 'response.completed': {
        const resp = payload.response as Record<string, unknown> | undefined;
        if (resp?.usage) usage = mapResponsesUsage(resp.usage);
        yield {
          type: 'done',
          usage,
          finishReason: typeof resp?.status === 'string' ? resp.status : undefined,
          raw: payload,
        };
        return;
      }

      case 'response.failed':
      case 'response.incomplete': {
        const resp = payload.response as Record<string, unknown> | undefined;
        const err = resp?.error as Record<string, unknown> | undefined;
        yield {
          type: 'error',
          message: String(err?.message ?? `Response ${type}`),
          code: err?.code != null ? String(err.code) : undefined,
          raw: payload,
        };
        break;
      }

      case 'error': {
        yield {
          type: 'error',
          message: String(payload.message ?? 'Unknown Responses error'),
          code: payload.code != null ? String(payload.code) : undefined,
          raw: payload,
        };
        break;
      }

      default:
        break;
    }
  }

  // Stream closed without `response.completed` — still signal completion.
  yield { type: 'done', usage };
}

function mapResponsesUsage(raw: unknown): TokenUsage {
  const u = asRecord(raw);
  const inputDetails = asRecord(u?.input_tokens_details);
  const outputDetails = asRecord(u?.output_tokens_details);
  const promptTokens = numberField(u, 'input_tokens');
  const cachedPromptTokens = numberField(inputDetails, 'cached_tokens');

  const usage: TokenUsage = {
    promptTokens,
    completionTokens: numberField(u, 'output_tokens'),
    totalTokens: numberField(u, 'total_tokens'),
  };

  addNumber(usage, 'cachedPromptTokens', cachedPromptTokens);
  if (promptTokens !== undefined && cachedPromptTokens !== undefined) {
    usage.uncachedPromptTokens = promptTokens - cachedPromptTokens;
  }
  addNumber(usage, 'reasoningTokens', numberField(outputDetails, 'reasoning_tokens'));

  return usage;
}
