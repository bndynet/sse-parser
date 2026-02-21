import type { ChatStreamEvent, StreamReaderOptions, TokenUsage } from '../types.js';
import { readSSEStream } from '../stream-reader.js';

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
  response: Response,
  options?: StreamReaderOptions,
): AsyncGenerator<ChatStreamEvent> {
  // Gemini has no `[DONE]` sentinel
  const opts: StreamReaderOptions = { ...options, doneSentinel: null };

  for await (const sse of readSSEStream(response, opts)) {
    if (!sse.data) continue;

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(sse.data);
    } catch {
      yield { type: 'error', message: 'Invalid JSON in Gemini SSE', code: 'parse_error' };
      continue;
    }

    // API-level error
    if (payload.error) {
      const err = payload.error as Record<string, unknown>;
      yield {
        type: 'error',
        message: String(err.message ?? 'Unknown Gemini error'),
        code: err.code != null ? String(err.code) : undefined,
      };
      continue;
    }

    const candidates = payload.candidates as Array<Record<string, unknown>> | undefined;
    if (!candidates || candidates.length === 0) {
      // Possible usage-only final chunk
      if (payload.usageMetadata) {
        yield { type: 'done', usage: mapGeminiUsage(payload.usageMetadata) };
      }
      continue;
    }

    const candidate = candidates[0];
    const content = candidate.content as Record<string, unknown> | undefined;
    const parts = content?.parts as Array<Record<string, unknown>> | undefined;

    if (parts) {
      for (const part of parts) {
        if (typeof part.text === 'string' && part.text) {
          yield { type: 'text', content: part.text };
        }
        // Gemini function-call parts
        if (part.functionCall) {
          const fc = part.functionCall as Record<string, unknown>;
          yield {
            type: 'tool_call',
            id: '',
            name: String(fc.name ?? ''),
            arguments: fc.args != null ? JSON.stringify(fc.args) : '',
          };
        }
      }
    }

    // Finish reason
    if (candidate.finishReason && candidate.finishReason !== 'FINISH_REASON_UNSPECIFIED') {
      yield {
        type: 'done',
        usage: payload.usageMetadata ? mapGeminiUsage(payload.usageMetadata) : undefined,
      };
    }
  }
}

function mapGeminiUsage(raw: unknown): TokenUsage {
  const u = raw as Record<string, unknown>;
  return {
    promptTokens: typeof u.promptTokenCount === 'number' ? u.promptTokenCount : undefined,
    completionTokens: typeof u.candidatesTokenCount === 'number' ? u.candidatesTokenCount : undefined,
    totalTokens: typeof u.totalTokenCount === 'number' ? u.totalTokenCount : undefined,
  };
}
