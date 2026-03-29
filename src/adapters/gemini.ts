import type { ChatStreamEvent, StreamInput, StreamReaderOptions, TokenUsage } from '../types.js';
import { readSSEStream } from '../stream-reader.js';
import { addNumber, asRecord, numberField } from './usage.js';

/**
 * Google Gemini streaming adapter.
 *
 * Gemini streams SSE when `?alt=sse` is appended to the endpoint URL.
 * Each event carries:
 *
 *   data: {"candidates":[{"content":{"parts":[{"text":"..."}],"role":"model"}}]}
 *
 * The stream ends when the underlying connection closes (no `[DONE]` sentinel).
 * A `finishReason` on the candidate signals logical completion.
 */
export async function* geminiStream(
  input: StreamInput,
  options?: StreamReaderOptions,
): AsyncGenerator<ChatStreamEvent> {
  // Gemini has no `[DONE]` sentinel
  const opts: StreamReaderOptions = { ...options, doneSentinel: null };

  // Accumulate usage and emit a single terminal `done` at stream end.
  let usage: TokenUsage | undefined;
  let finishReason: string | undefined;
  let lastPayload: unknown;
  // Monotonic index so each function call can be told apart by callers.
  let toolIndex = 0;

  for await (const sse of readSSEStream(input, opts)) {
    if (!sse.data) continue;

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(sse.data);
    } catch {
      yield { type: 'error', message: 'Invalid JSON in Gemini SSE', code: 'parse_error' };
      continue;
    }
    lastPayload = payload;

    // API-level error
    if (payload.error) {
      const err = payload.error as Record<string, unknown>;
      yield {
        type: 'error',
        message: String(err.message ?? 'Unknown Gemini error'),
        code: err.code != null ? String(err.code) : undefined,
        raw: payload,
      };
      continue;
    }

    if (payload.usageMetadata) {
      usage = mapGeminiUsage(payload.usageMetadata);
    }

    const candidates = payload.candidates as Array<Record<string, unknown>> | undefined;
    if (!candidates || candidates.length === 0) {
      continue;
    }

    const candidate = candidates[0];
    if (
      typeof candidate.finishReason === 'string' &&
      candidate.finishReason !== 'FINISH_REASON_UNSPECIFIED'
    ) {
      finishReason = candidate.finishReason;
    }

    const content = candidate.content as Record<string, unknown> | undefined;
    const parts = content?.parts as Array<Record<string, unknown>> | undefined;

    if (parts) {
      for (const part of parts) {
        if (typeof part.text === 'string' && part.text) {
          yield { type: 'text', content: part.text, raw: payload };
        }
        // Gemini function-call parts (delivered whole, not fragmented)
        if (part.functionCall) {
          const fc = part.functionCall as Record<string, unknown>;
          yield {
            type: 'tool_call',
            id: '',
            name: String(fc.name ?? ''),
            arguments: fc.args != null ? JSON.stringify(fc.args) : '',
            index: toolIndex++,
            raw: payload,
          };
        }
      }
    }
  }

  yield { type: 'done', usage, finishReason, raw: lastPayload };
}

function mapGeminiUsage(raw: unknown): TokenUsage {
  const u = asRecord(raw);
  const usage: TokenUsage = {
    promptTokens: numberField(u, 'promptTokenCount'),
    completionTokens: numberField(u, 'candidatesTokenCount'),
    totalTokens: numberField(u, 'totalTokenCount'),
  };

  addNumber(usage, 'cachedPromptTokens', numberField(u, 'cachedContentTokenCount'));
  addNumber(usage, 'toolUsePromptTokens', numberField(u, 'toolUsePromptTokenCount'));
  addNumber(usage, 'reasoningTokens', numberField(u, 'thoughtsTokenCount'));

  return usage;
}
