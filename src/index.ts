// Layer 1 — Low-level parsers
export { SSEParser } from './parser.js';
export { NDJSONParser } from './ndjson-parser.js';

// Layer 2 — Stream readers (fetch Response → AsyncGenerator)
export { readSSEStream, readNDJSONStream } from './stream-reader.js';

// Layer 3 — AI vendor adapters
export { openaiStream } from './adapters/openai.js';
export { openaiResponsesStream } from './adapters/openai-responses.js';
export { anthropicStream } from './adapters/anthropic.js';
export { geminiStream } from './adapters/gemini.js';
export { ollamaStream } from './adapters/ollama.js';

// Unified entry point
export { chatStream } from './chat.js';
export type { ChatProvider, ChatStreamOptions } from './chat.js';

// Errors
export { SSEError, SSEParseError, SSEConnectionError, SSETimeoutError } from './errors.js';

// Types
export type {
  SSEEvent,
  SSEParserCallbacks,
  NDJSONParserCallbacks,
  StreamInput,
  StreamReaderOptions,
  ChatStreamEvent,
  TokenUsage,
} from './types.js';
