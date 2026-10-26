/**
 * Anthropic Messages ⇄ OpenAI Chat Completions 转换。
 *
 * Claude Code 只认 POST /v1/messages（Anthropic 方言），而插件的 shim 只出
 * OpenAI 方言。这里做双向翻译：
 *   · 请求：system / messages / tools / tool_choice / max_tokens / stream
 *   · 响应：非流式一次性 JSON；流式翻译成 Anthropic 的 SSE 事件序列
 *
 * 只翻译协议，不碰模型语义：模型 id、温度、停止词原样透传。
 */

/** Anthropic 的 content block 数组 → OpenAI 的 messages 数组。 */
function toOpenAIMessages(body) {
  const messages = [];
  const systemText = typeof body.system === 'string'
    ? body.system
    : Array.isArray(body.system)
      ? body.system.filter((b) => b?.type === 'text').map((b) => b.text).join('\n')
      : '';
  if (systemText !== '') messages.push({ role: 'system', content: systemText });

  for (const m of body.messages ?? []) {
    const blocks = Array.isArray(m.content) ? m.content : [{ type: 'text', text: String(m.content ?? '') }];
    const textParts = [];
    const toolCalls = [];
    const toolResults = [];
    for (const b of blocks) {
      if (b?.type === 'text') textParts.push(b.text ?? '');
      else if (b?.type === 'tool_use') {
        toolCalls.push({
          id: b.id,
          type: 'function',
          function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
        });
      } else if (b?.type === 'tool_result') {
        const content = Array.isArray(b.content)
          ? b.content.filter((x) => x?.type === 'text').map((x) => x.text).join('\n')
          : String(b.content ?? '');
        toolResults.push({ role: 'tool', tool_call_id: b.tool_use_id, content });
      } else if (b?.type === 'image' && b.source?.type === 'base64') {
        textParts.push(`[image:${b.source.media_type}]`);
      }
    }
    // 工具结果必须先落地，且各自独立成一条 role:"tool"
    for (const r of toolResults) messages.push(r);
    if (textParts.length > 0 || toolCalls.length > 0) {
      const msg = { role: m.role === 'assistant' ? 'assistant' : 'user', content: textParts.join('\n') };
      if (toolCalls.length > 0) msg.tool_calls = toolCalls;
      // OpenAI 允许 assistant 只有 tool_calls、content 为空串
      if (msg.content === '' && toolCalls.length === 0) continue;
      messages.push(msg);
    }
  }
  return messages;
}

/** Anthropic tools → OpenAI tools。 */
function toOpenAITools(tools) {
  if (!Array.isArray(tools)) return undefined;
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description ?? '',
      parameters: t.input_schema ?? { type: 'object', properties: {} },
    },
  }));
}

/** Anthropic 请求体 → OpenAI 请求体。 */
export function toOpenAIBody(body, upstreamModel) {
  const out = {
    model: upstreamModel,
    messages: toOpenAIMessages(body),
    stream: body.stream === true,
  };
  const tools = toOpenAITools(body.tools);
  if (tools !== undefined && tools.length > 0) out.tools = tools;
  if (body.tool_choice?.type === 'tool' && typeof body.tool_choice.name === 'string') {
    out.tool_choice = { type: 'function', function: { name: body.tool_choice.name } };
  } else if (body.tool_choice?.type === 'any') out.tool_choice = 'required';
  else if (body.tool_choice?.type === 'auto') out.tool_choice = 'auto';
  else if (body.tool_choice?.type === 'none') out.tool_choice = 'none';
  if (typeof body.max_tokens === 'number') out.max_tokens = body.max_tokens;
  if (typeof body.temperature === 'number') out.temperature = body.temperature;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length > 0) out.stop = body.stop_sequences;
  return out;
}

const STOP_MAP = { stop: 'end_turn', length: 'max_tokens', tool_calls: 'tool_use', function_call: 'tool_use', content_filter: 'end_turn' };

/** OpenAI 非流式响应 → Anthropic message。 */
export function toAnthropicMessage(openai, modelId) {
  const choice = openai?.choices?.[0] ?? {};
  const msg = choice.message ?? {};
  const content = [];
  const reasoning = msg.reasoning_content;
  if (typeof reasoning === 'string' && reasoning !== '') content.push({ type: 'thinking', thinking: reasoning, signature: '' });
  if (typeof msg.content === 'string' && msg.content !== '') content.push({ type: 'text', text: msg.content });
  for (const call of msg.tool_calls ?? []) {
    let input = {};
    try { input = JSON.parse(call.function?.arguments ?? '{}'); } catch { input = { _raw: call.function?.arguments }; }
    content.push({ type: 'tool_use', id: call.id, name: call.function?.name, input });
  }
  if (content.length === 0) content.push({ type: 'text', text: '' });
  return {
    id: openai?.id ?? `msg_${Date.now().toString(36)}`,
    type: 'message',
    role: 'assistant',
    model: modelId,
    content,
    stop_reason: STOP_MAP[choice.finish_reason] ?? 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: openai?.usage?.prompt_tokens ?? 0,
      output_tokens: openai?.usage?.completion_tokens ?? 0,
    },
  };
}

/**
 * OpenAI SSE 流 → Anthropic SSE 事件流。
 *
 * 只读插件 shim 实际会发的字段：delta.content / delta.reasoning_content /
 * delta.tool_calls / finish_reason。tool_calls 是**分片累积**的
 * （index + 部分 arguments），必须按 index 拼装后才发 input_json_delta。
 */
export async function* toAnthropicStream(openaiStream, modelId) {
  const messageId = `msg_${Date.now().toString(36)}`;
  yield sse('message_start', {
    type: 'message_start',
    message: { id: messageId, type: 'message', role: 'assistant', model: modelId, content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 } },
  });
  yield sse('ping', { type: 'ping' });

  let blockIndex = -1;
  let openKind = null; // 'text' | 'thinking' | 'tool_use'
  const toolBlocks = new Map(); // openai tool_call index → anthropic block index
  let stopReason = 'end_turn';
  let outputTokens = 0;
  let sawAnyBlock = false;

  const closeBlock = () => {
    if (openKind === null) return null;
    const ev = sse('content_block_stop', { type: 'content_block_stop', index: blockIndex });
    openKind = null;
    return ev;
  };

  const reader = openaiStream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith('data:')) continue; // 忽略 ": heartbeat" 之类的注释行
        const payload = line.slice(5).trim();
        if (payload === '' || payload === '[DONE]') continue;
        let chunk;
        try { chunk = JSON.parse(payload); } catch { continue; }
        const choice = chunk.choices?.[0];
        if (choice === undefined) continue;
        const delta = choice.delta ?? {};

        if (typeof delta.reasoning_content === 'string' && delta.reasoning_content !== '') {
          if (openKind !== 'thinking') {
            const close = closeBlock();
            if (close !== null) yield close;
            blockIndex += 1;
            openKind = 'thinking';
            sawAnyBlock = true;
            yield sse('content_block_start', {
              type: 'content_block_start', index: blockIndex,
              content_block: { type: 'thinking', thinking: '', signature: '' },
            });
          }
          yield sse('content_block_delta', {
            type: 'content_block_delta', index: blockIndex,
            delta: { type: 'thinking_delta', thinking: delta.reasoning_content },
          });
        }

        if (typeof delta.content === 'string' && delta.content !== '') {
          if (openKind !== 'text') {
            const close = closeBlock();
            if (close !== null) yield close;
            blockIndex += 1;
            openKind = 'text';
            sawAnyBlock = true;
            yield sse('content_block_start', {
              type: 'content_block_start', index: blockIndex,
              content_block: { type: 'text', text: '' },
            });
          }
          yield sse('content_block_delta', {
            type: 'content_block_delta', index: blockIndex,
            delta: { type: 'text_delta', text: delta.content },
          });
        }

        for (const call of delta.tool_calls ?? []) {
          const key = call.index ?? 0;
          if (!toolBlocks.has(key)) {
            const close = closeBlock();
            if (close !== null) yield close;
            blockIndex += 1;
            openKind = 'tool_use';
            sawAnyBlock = true;
            toolBlocks.set(key, blockIndex);
            yield sse('content_block_start', {
              type: 'content_block_start', index: blockIndex,
              content_block: { type: 'tool_use', id: call.id ?? `toolu_${key}`, name: call.function?.name ?? 'unknown', input: {} },
            });
          }
          const args = call.function?.arguments;
          if (typeof args === 'string' && args !== '') {
            yield sse('content_block_delta', {
              type: 'content_block_delta', index: toolBlocks.get(key),
              delta: { type: 'input_json_delta', partial_json: args },
            });
          }
        }

        if (typeof choice.finish_reason === 'string' && choice.finish_reason !== '') {
          stopReason = STOP_MAP[choice.finish_reason] ?? 'end_turn';
        }
        if (typeof chunk.usage?.completion_tokens === 'number') outputTokens = chunk.usage.completion_tokens;
      }
    }
  } finally {
    reader.releaseLock();
  }

  const close = closeBlock();
  if (close !== null) yield close;
  if (!sawAnyBlock) {
    blockIndex += 1;
    yield sse('content_block_start', { type: 'content_block_start', index: blockIndex, content_block: { type: 'text', text: '' } });
    yield sse('content_block_stop', { type: 'content_block_stop', index: blockIndex });
  }
  yield sse('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: outputTokens },
  });
  yield sse('message_stop', { type: 'message_stop' });
}

function sse(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
