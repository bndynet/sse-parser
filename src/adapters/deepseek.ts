import type { ChatStreamEvent, StreamInput, StreamReaderOptions } from '../types.js';
import { openaiStream } from './openai.js';

/**
 * DeepSeek streaming adapter.
 *
 * DeepSeek's OpenAI-format `POST /chat/completions` stream uses the same SSE
 * shape handled by {@link openaiStream}, including `delta.content`,
 * `delta.reasoning_content`, streamed tool calls, usage chunks, and `[DONE]`.
 */
export function deepseekStream(
  input: StreamInput,
  options?: StreamReaderOptions,
): AsyncGenerator<ChatStreamEvent> {
  return openaiStream(input, options);
}
