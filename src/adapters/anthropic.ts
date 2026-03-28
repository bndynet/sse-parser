import type { ChatStreamEvent, StreamInput, StreamReaderOptions, TokenUsage } from '../types.js';
import { readSSEStream } from '../stream-reader.js';

/**
 * Anthropic Messages streaming adapter.
 *
 * Handles `POST /v1/messages` with `stream: true`.
 * Anthropic uses the `event:` SSE field to convey typed lifecycle events:
 *
 *   event: message_start       → message metadata
 *   event: content_block_start → begin of a content block (text / tool_use / thinking)
 *   event: content_block_delta → incremental text / JSON / thinking chunk
 *   event: content_block_stop  → end of the block
 *   event: message_delta       → stop_reason + usage
 *   event: message_stop        → stream over
 *   event: error               → API error
 *   event: ping                → keep-alive (ignored)
 */
export async function* anthropicStream(
  input: StreamInput,
  options?: StreamReaderOptions,
): AsyncGenerator<ChatStreamEvent> {
  // Anthropic does NOT use `data: [DONE]` — stream ends with `message_stop`
  const opts: StreamReaderOptions = { ...options, doneSentinel: null };

  // Captured on `message_delta`; emitted with the single terminal `done`.
  let usage: TokenUsage | undefined;
  let finishReason: string | undefined;
  let lastPayload: unknown;

  for await (const sse of readSSEStream(input, opts)) {
    if (!sse.data) continue;

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(sse.data);
    } catch {
      yield { type: 'error', message: 'Invalid JSON in Anthropic SSE', code: 'parse_error' };
      continue;
    }
    lastPayload = payload;

    // Anthropic carries the content-block index on the event payload so
    // streamed tool-call fragments can be grouped by caller.
    const index = typeof payload.index === 'number' ? payload.index : undefined;

    switch (sse.event) {
      case 'content_block_delta': {
        const delta = payload.delta as Record<string, unknown> | undefined;
        if (!delta) break;

        if (delta.type === 'text_delta' && typeof delta.text === 'string') {
          yield { type: 'text', content: delta.text, raw: payload };
        } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
          yield { type: 'reasoning', content: delta.thinking, raw: payload };
        } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
          // Tool use argument streaming — expose as tool_call with incremental args
          yield {
            type: 'tool_call',
            id: '',
            name: '',
            arguments: delta.partial_json,
            index,
            raw: payload,
          };
        }
        break;
      }

      case 'content_block_start': {
        const block = payload.content_block as Record<string, unknown> | undefined;
        if (block?.type === 'tool_use') {
          yield {
            type: 'tool_call',
            id: String(block.id ?? ''),
            name: String(block.name ?? ''),
            arguments: '',
            index,
            raw: payload,
          };
        }
        break;
      }

      case 'message_delta': {
        // Capture usage and stop_reason; the terminal `done` is emitted on
        // `message_stop`.
        const u = payload.usage as Record<string, unknown> | undefined;
        if (u) usage = mapAnthropicUsage(u);
        const delta = payload.delta as Record<string, unknown> | undefined;
        if (typeof delta?.stop_reason === 'string') {
          finishReason = delta.stop_reason;
        }
        break;
      }

      case 'message_stop':
        yield { type: 'done', usage, finishReason, raw: payload };
        return;

      case 'error': {
        const err = payload.error as Record<string, unknown> | undefined;
        yield {
          type: 'error',
          message: String(err?.message ?? 'Unknown Anthropic error'),
          code: err?.type != null ? String(err.type) : undefined,
          raw: payload,
        };
        break;
      }

      case 'ping':
      case 'message_start':
      case 'content_block_stop':
        // No user-facing content — skip
        break;

      default:
        break;
    }
  }

  // Stream closed without an explicit `message_stop` — still signal completion.
  yield { type: 'done', usage, finishReason, raw: lastPayload };
}

function mapAnthropicUsage(u: Record<string, unknown>): TokenUsage {
  return {
    promptTokens: typeof u.input_tokens === 'number' ? u.input_tokens : undefined,
    completionTokens: typeof u.output_tokens === 'number' ? u.output_tokens : undefined,
  };
}
