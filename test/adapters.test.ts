import { describe, it, expect } from 'vitest';
import {
  openaiStream,
  openaiResponsesStream,
  deepseekStream,
  anthropicStream,
  geminiStream,
  ollamaStream,
  chatStream,
} from '../src/index.js';
import type { ChatStreamEvent } from '../src/types.js';

const enc = new TextEncoder();

function sseResponse(lines: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) controller.enqueue(enc.encode(line));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

async function collect(gen: AsyncGenerator<ChatStreamEvent>): Promise<ChatStreamEvent[]> {
  const out: ChatStreamEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

const sse = (obj: unknown, event?: string): string =>
  (event ? `event: ${event}\n` : '') + `data: ${JSON.stringify(obj)}\n\n`;

describe('openaiStream', () => {
  it('yields text and exactly one done with usage', async () => {
    const events = await collect(
      openaiStream(
        sseResponse([
          sse({ choices: [{ delta: { content: 'Hello' } }] }),
          sse({ choices: [{ delta: { content: ' world' } }] }),
          sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
          sse({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }),
          'data: [DONE]\n\n',
        ]),
      ),
    );

    const texts = events.filter((e) => e.type === 'text').map((e) => (e as any).content);
    expect(texts).toEqual(['Hello', ' world']);

    const dones = events.filter((e) => e.type === 'done');
    expect(dones).toHaveLength(1);
    expect((dones[0] as any).usage).toEqual({
      promptTokens: 3,
      completionTokens: 2,
      totalTokens: 5,
    });
    expect((dones[0] as any).finishReason).toBe('stop');
  });

  it('attaches raw payload to each event', async () => {
    const events = await collect(
      openaiStream(
        sseResponse([
          sse({ id: 'chunk-1', choices: [{ delta: { content: 'Hi' } }] }),
          sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
          'data: [DONE]\n\n',
        ]),
      ),
    );
    const text = events.find((e) => e.type === 'text');
    expect((text as any).raw).toMatchObject({ id: 'chunk-1' });
  });

  it('preserves tool_call index so fragments can be regrouped', async () => {
    const events = await collect(
      openaiStream(
        sseResponse([
          sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'get_weather', arguments: '' } }] } }] }),
          sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: '', arguments: '{"city":' } }] } }] }),
          sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: '', arguments: '"NYC"}' } }] } }] }),
          sse({ choices: [{ delta: { tool_calls: [{ index: 1, id: 'call_2', function: { name: 'get_time', arguments: '{}' } }] } }] }),
          sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
          'data: [DONE]\n\n',
        ]),
      ),
    );

    const tcs = events.filter((e) => e.type === 'tool_call') as Array<Extract<ChatStreamEvent, { type: 'tool_call' }>>;
    expect(tcs.every((t) => typeof t.index === 'number')).toBe(true);
    expect(tcs.filter((t) => t.index === 0)).toHaveLength(3);
    expect(tcs.filter((t) => t.index === 1)).toHaveLength(1);
  });
});

describe('deepseekStream', () => {
  it('reuses the OpenAI-compatible stream shape and maps DeepSeek usage details', async () => {
    const events = await collect(
      deepseekStream(
        sseResponse([
          sse({ choices: [{ delta: { reasoning_content: 'think' } }] }),
          sse({ choices: [{ delta: { content: 'Answer' } }] }),
          sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'lookup', arguments: '{"q":1}' } }] } }] }),
          sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
          sse({
            choices: [],
            usage: {
              prompt_tokens: 10,
              prompt_cache_hit_tokens: 4,
              prompt_cache_miss_tokens: 6,
              completion_tokens: 5,
              completion_tokens_details: { reasoning_tokens: 2 },
              total_tokens: 15,
            },
          }),
          'data: [DONE]\n\n',
        ]),
      ),
    );

    expect(events.filter((e) => e.type === 'reasoning').map((e) => (e as any).content)).toEqual(['think']);
    expect(events.filter((e) => e.type === 'text').map((e) => (e as any).content)).toEqual(['Answer']);
    expect(events.filter((e) => e.type === 'tool_call')).toHaveLength(1);

    const done = events.find((e) => e.type === 'done') as Extract<ChatStreamEvent, { type: 'done' }>;
    expect(done.usage).toEqual({
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      cachedPromptTokens: 4,
      uncachedPromptTokens: 6,
      reasoningTokens: 2,
    });
    expect(done.finishReason).toBe('stop');
  });
});

describe('anthropicStream', () => {
  it('emits a single done with finishReason and carries content-block index', async () => {
    const events = await collect(
      anthropicStream(
        sseResponse([
          sse({ type: 'message_start', message: {} }, 'message_start'),
          sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, 'content_block_start'),
          sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } }, 'content_block_delta'),
          sse({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu_1', name: 'search' } }, 'content_block_start'),
          sse({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"q":1}' } }, 'content_block_delta'),
          sse({
            type: 'message_delta',
            delta: { stop_reason: 'end_turn' },
            usage: {
              input_tokens: 3,
              cache_read_input_tokens: 10,
              cache_creation_input_tokens: 2,
              output_tokens: 7,
            },
          }, 'message_delta'),
          sse({ type: 'message_stop' }, 'message_stop'),
        ]),
      ),
    );

    const dones = events.filter((e) => e.type === 'done');
    expect(dones).toHaveLength(1);
    expect((dones[0] as any).finishReason).toBe('end_turn');
    expect((dones[0] as any).usage).toEqual({
      promptTokens: 15,
      completionTokens: 7,
      uncachedPromptTokens: 3,
      cachedPromptTokens: 10,
      cacheCreationPromptTokens: 2,
    });

    const tcs = events.filter((e) => e.type === 'tool_call') as Array<Extract<ChatStreamEvent, { type: 'tool_call' }>>;
    expect(tcs.find((t) => t.name === 'search')?.index).toBe(1);
    expect(tcs.find((t) => t.arguments === '{"q":1}')?.index).toBe(1);
  });
});

describe('chatStream', () => {
  it('dispatches to the openai adapter and matches openaiStream', async () => {
    const lines = [
      sse({ choices: [{ delta: { content: 'Hi' } }] }),
      sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
      'data: [DONE]\n\n',
    ];

    const viaChat = await collect(chatStream(sseResponse(lines), { provider: 'openai' }));
    const viaDirect = await collect(openaiStream(sseResponse(lines)));

    const texts = (evts: ChatStreamEvent[]) =>
      evts.filter((e) => e.type === 'text').map((e) => (e as any).content);
    expect(texts(viaChat)).toEqual(texts(viaDirect));
    expect(viaChat.filter((e) => e.type === 'done')).toHaveLength(1);
  });

  it('dispatches to the deepseek adapter and matches deepseekStream', async () => {
    const lines = [
      sse({ choices: [{ delta: { content: 'Hi' } }] }),
      sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
      'data: [DONE]\n\n',
    ];

    const viaChat = await collect(chatStream(sseResponse(lines), { provider: 'deepseek' }));
    const viaDirect = await collect(deepseekStream(sseResponse(lines)));

    const texts = (evts: ChatStreamEvent[]) =>
      evts.filter((e) => e.type === 'text').map((e) => (e as any).content);
    expect(texts(viaChat)).toEqual(texts(viaDirect));
    expect(viaChat.filter((e) => e.type === 'done')).toHaveLength(1);
  });
});

describe('geminiStream', () => {
  it('emits a single done and distinct indices per function call', async () => {
    const events = await collect(
      geminiStream(
        sseResponse([
          sse({ candidates: [{ content: { parts: [{ text: 'Hi' }] } }] }),
          sse({
            candidates: [{ content: { parts: [{ functionCall: { name: 'a', args: {} } }, { functionCall: { name: 'b', args: {} } }] }, finishReason: 'STOP' }],
            usageMetadata: {
              promptTokenCount: 1,
              cachedContentTokenCount: 4,
              candidatesTokenCount: 2,
              toolUsePromptTokenCount: 5,
              thoughtsTokenCount: 6,
              totalTokenCount: 13,
            },
          }),
        ]),
      ),
    );

    expect(events.filter((e) => e.type === 'done')).toHaveLength(1);
    expect((events.find((e) => e.type === 'done') as any).usage).toEqual({
      promptTokens: 1,
      completionTokens: 2,
      totalTokens: 13,
      cachedPromptTokens: 4,
      toolUsePromptTokens: 5,
      reasoningTokens: 6,
    });
    const tcs = events.filter((e) => e.type === 'tool_call') as Array<Extract<ChatStreamEvent, { type: 'tool_call' }>>;
    expect(tcs.map((t) => t.index)).toEqual([0, 1]);
  });
});

describe('openaiResponsesStream', () => {
  it('maps text/reasoning/tool-call/usage from Responses events', async () => {
    const events = await collect(
      openaiResponsesStream(
        sseResponse([
          sse({ type: 'response.created', response: {} }, 'response.created'),
          sse({ type: 'response.reasoning_text.delta', delta: 'thinking' }, 'response.reasoning_text.delta'),
          sse({ type: 'response.output_text.delta', delta: 'Hello' }, 'response.output_text.delta'),
          sse({ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'call_1', name: 'lookup' } }, 'response.output_item.added'),
          sse({ type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'call_1', delta: '{"x":1}' }, 'response.function_call_arguments.delta'),
          sse({
            type: 'response.completed',
            response: {
              usage: {
                input_tokens: 4,
                input_tokens_details: { cached_tokens: 1 },
                output_tokens: 6,
                output_tokens_details: { reasoning_tokens: 2 },
                total_tokens: 10,
              },
            },
          }, 'response.completed'),
        ]),
      ),
    );

    expect(events.filter((e) => e.type === 'text').map((e) => (e as any).content)).toEqual(['Hello']);
    expect(events.filter((e) => e.type === 'reasoning').map((e) => (e as any).content)).toEqual(['thinking']);

    const tcs = events.filter((e) => e.type === 'tool_call') as Array<Extract<ChatStreamEvent, { type: 'tool_call' }>>;
    expect(tcs.find((t) => t.name === 'lookup')?.index).toBe(0);
    expect(tcs.find((t) => t.arguments === '{"x":1}')?.index).toBe(0);

    const dones = events.filter((e) => e.type === 'done');
    expect(dones).toHaveLength(1);
    expect((dones[0] as any).usage).toEqual({
      promptTokens: 4,
      completionTokens: 6,
      totalTokens: 10,
      cachedPromptTokens: 1,
      uncachedPromptTokens: 3,
      reasoningTokens: 2,
    });
  });
});

describe('ollamaStream', () => {
  it('keeps Ollama token counts mapped to the common usage fields', async () => {
    const events = await collect(
      ollamaStream(
        sseResponse([
          '{"message":{"content":"Hi"},"done":false}\n',
          '{"done":true,"prompt_eval_count":4,"eval_count":6,"done_reason":"stop"}\n',
        ]),
      ),
    );

    expect(events.filter((e) => e.type === 'text').map((e) => (e as any).content)).toEqual(['Hi']);
    expect((events.find((e) => e.type === 'done') as any).usage).toEqual({
      promptTokens: 4,
      completionTokens: 6,
      totalTokens: 10,
    });
  });
});
