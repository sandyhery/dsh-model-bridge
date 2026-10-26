/**
 * OpenAI Responses ⇄ Chat Completions 转换（给 Codex 用）。
 *
 * Codex 0.163 已删除 wire_api="chat"：只接受 POST /v1/responses。
 * 插件 shim 只出 chat completions，所以这里翻译两个方向：
 *   · 请求：instructions + input(数组/字符串) + tools(扁平) + max_output_tokens
 *   · 响应：非流式 response 对象；流式翻译成 Codex 认的
 *     response.output_item.added / response.output_text.delta /
 *     response.function_call_arguments.delta / response.completed
 *
 * Codex 的 tools 是**扁平**的 {type:"function", name, parameters}，
 * 而 chat completions 要 {type:"function", function:{name, parameters}} —— 形状不同。
 */

/** Responses 的 input → chat 的 messages。 */
function toChatMessages(body) {
  const messages = [];
  const instructions = typeof body.instructions === 'string' ? body.instructions : '';
  if (instructions !== '') messages.push({ role: 'system', content: instructions });

  const input = body.input;
  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input });
    return messages;
  }
  for (const item of Array.isArray(input) ? input : []) {
    if (item === null || typeof item !== 'object') continue;
    // 会话项：{type:"message", role, content:[{type:"input_text"|"output_text", text}]}
    if (item.type === 'message' || item.role !== undefined) {
      const parts = Array.isArray(item.content) ? item.content : [{ type: 'text', text: String(item.content ?? '') }];
      const text = parts
        .map((p) => (typeof p === 'string' ? p : p?.text ?? p?.input_text ?? p?.output_text ?? ''))
        .filter((t) => t !== '')
        .join('\n');
      messages.push({ role: item.role === 'assistant' ? 'assistant' : item.role === 'system' ? 'system' : 'user', content: text });
      continue;
    }
    // 上一轮的工具调用 / 结果（Codex 会把这些作为 input 项回传）
    if (item.type === 'function_call') {
      messages.push({
        role: 'assistant',
        content: '',
        tool_calls: [{ id: item.call_id ?? item.id, type: 'function', function: { name: item.name, arguments: item.arguments ?? '{}' } }],
      });
      continue;
    }
    if (item.type === 'function_call_output') {
      const output = typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? '');
      messages.push({ role: 'tool', tool_call_id: item.call_id ?? item.id, content: output });
      continue;
    }
    if (item.type === 'reasoning') continue; // 思考块不回传
  }
  return messages;
}

/** Codex 的扁平 tools → chat 的嵌套 tools。 */
function toChatTools(tools) {
  if (!Array.isArray(tools)) return undefined;
  const out = [];
  for (const t of tools) {
    if (t?.type !== 'function') continue; // 只处理 function；内置 web_search 等跳过
    out.push({
      type: 'function',
      function: { name: t.name, description: t.description ?? '', parameters: t.parameters ?? { type: 'object', properties: {} } },
    });
  }
  return out.length > 0 ? out : undefined;
}

export function toChatBody(body, upstreamModel) {
  const out = { model: upstreamModel, messages: toChatMessages(body), stream: body.stream === true };
  const tools = toChatTools(body.tools);
  if (tools !== undefined) out.tools = tools;
  if (typeof body.max_output_tokens === 'number') out.max_tokens = body.max_output_tokens;
  if (typeof body.temperature === 'number') out.temperature = body.temperature;
  if (body.tool_choice !== undefined) {
    if (typeof body.tool_choice === 'string') out.tool_choice = body.tool_choice === 'required' ? 'required' : body.tool_choice;
    else if (body.tool_choice?.type === 'function') out.tool_choice = { type: 'function', function: { name: body.tool_choice.name } };
  }
  if (body.parallel_tool_calls !== undefined) out.parallel_tool_calls = body.parallel_tool_calls;
  return out;
}

const STATUS_MAP = { stop: 'completed', length: 'incomplete', tool_calls: 'completed', content_filter: 'incomplete' };

/** OpenAI 非流式响应 → Responses 对象。 */
export function toResponsesObject(openai, modelId) {
  const choice = openai?.choices?.[0] ?? {};
  const msg = choice.message ?? {};
  const output = [];
  if (typeof msg.reasoning_content === 'string' && msg.reasoning_content !== '') {
    output.push({ type: 'reasoning', id: `rs_${Date.now().toString(36)}`, summary: [{ type: 'summary_text', text: msg.reasoning_content }] });
  }
  if (typeof msg.content === 'string' && msg.content !== '') {
    output.push({
      type: 'message', id: `msg_${Date.now().toString(36)}`, role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: msg.content, annotations: [] }],
    });
  }
  for (const call of msg.tool_calls ?? []) {
    output.push({
      type: 'function_call', id: `fc_${Date.now().toString(36)}`, call_id: call.id,
      name: call.function?.name, arguments: call.function?.arguments ?? '{}', status: 'completed',
    });
  }
  return {
    id: openai?.id ?? `resp_${Date.now().toString(36)}`,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    model: modelId,
    status: STATUS_MAP[choice.finish_reason] ?? 'completed',
    output,
    output_text: typeof msg.content === 'string' ? msg.content : '',
    usage: {
      input_tokens: openai?.usage?.prompt_tokens ?? 0,
      output_tokens: openai?.usage?.completion_tokens ?? 0,
      total_tokens: openai?.usage?.total_tokens ?? 0,
    },
    parallel_tool_calls: true,
    tool_choice: 'auto',
    tools: [],
  };
}

/**
 * OpenAI SSE 流 → Responses SSE 事件流。
 *
 * Codex 的 runtime 靠事件类型推进状态机，缺 response.completed 会挂住；
 * 每个 function_call 都必须有 added → arguments.delta → done 三段。
 */
export async function* toResponsesStream(openaiStream, modelId) {
  const responseId = `resp_${Date.now().toString(36)}`;
  const createdAt = Math.floor(Date.now() / 1000);
  yield sse('response.created', {
    type: 'response.created',
    response: { id: responseId, object: 'response', created_at: createdAt, model: modelId, status: 'in_progress', output: [], output_text: '', usage: null },
  });
  yield sse('response.in_progress', {
    type: 'response.in_progress',
    response: { id: responseId, object: 'response', created_at: createdAt, model: modelId, status: 'in_progress', output: [], output_text: '', usage: null },
  });

  let outputIndex = -1;
  let textIndex = null;
  let textBuf = '';
  let reasoningIndex = null;
  let reasoningBuf = '';
  const toolItems = new Map();
  let finishReason;
  let usage;

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
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '' || payload === '[DONE]') continue;
        let chunk;
        try { chunk = JSON.parse(payload); } catch { continue; }
        const choice = chunk.choices?.[0];
        if (choice === undefined) continue;
        const delta = choice.delta ?? {};

        if (typeof delta.reasoning_content === 'string' && delta.reasoning_content !== '') {
          if (reasoningIndex === null) {
            outputIndex += 1;
            reasoningIndex = outputIndex;
            yield sse('response.output_item.added', {
              type: 'response.output_item.added', output_index: reasoningIndex,
              item: { type: 'reasoning', id: `rs_${Date.now().toString(36)}`, summary: [] },
            });
          }
          reasoningBuf += delta.reasoning_content;
          yield sse('response.reasoning_summary_text.delta', {
            type: 'response.reasoning_summary_text.delta', item_id: `rs_${reasoningIndex}`, output_index: reasoningIndex,
            summary_index: 0, delta: delta.reasoning_content,
          });
        }

        if (typeof delta.content === 'string' && delta.content !== '') {
          if (textIndex === null) {
            outputIndex += 1;
            textIndex = outputIndex;
            const item = { type: 'message', id: `msg_${Date.now().toString(36)}`, role: 'assistant', status: 'in_progress', content: [] };
            yield sse('response.output_item.added', { type: 'response.output_item.added', output_index: textIndex, item });
            yield sse('response.content_part.added', {
              type: 'response.content_part.added', item_id: item.id, output_index: textIndex, content_index: 0,
              part: { type: 'output_text', text: '', annotations: [] },
            });
          }
          textBuf += delta.content;
          yield sse('response.output_text.delta', {
            type: 'response.output_text.delta', item_id: `msg_${textIndex}`, output_index: textIndex,
            content_index: 0, delta: delta.content,
          });
        }

        for (const call of delta.tool_calls ?? []) {
          const key = call.index ?? 0;
          if (!toolItems.has(key)) {
            outputIndex += 1;
            const id = call.id ?? `fc_${Date.now().toString(36)}_${key}`;
            toolItems.set(key, { outputIndex, id, name: call.function?.name ?? 'unknown', args: '' });
            yield sse('response.output_item.added', {
              type: 'response.output_item.added', output_index: outputIndex,
              item: { type: 'function_call', id, call_id: id, name: call.function?.name ?? 'unknown', arguments: '', status: 'in_progress' },
            });
          }
          const t = toolItems.get(key);
          const frag = call.function?.arguments;
          if (typeof frag === 'string' && frag !== '') {
            t.args += frag;
            yield sse('response.function_call_arguments.delta', {
              type: 'response.function_call_arguments.delta', item_id: t.id, output_index: t.outputIndex, delta: frag,
            });
          }
        }

        if (typeof choice.finish_reason === 'string' && choice.finish_reason !== '') finishReason = choice.finish_reason;
        if (chunk.usage !== undefined) usage = chunk.usage;
      }
    }
  } finally {
    reader.releaseLock();
  }

  if (reasoningIndex !== null) {
    yield sse('response.output_item.done', {
      type: 'response.output_item.done', output_index: reasoningIndex,
      item: { type: 'reasoning', id: `rs_${reasoningIndex}`, summary: [{ type: 'summary_text', text: reasoningBuf }] },
    });
  }
  if (textIndex !== null) {
    yield sse('response.output_text.done', {
      type: 'response.output_text.done', item_id: `msg_${textIndex}`, output_index: textIndex, content_index: 0, text: textBuf,
    });
    yield sse('response.output_item.done', {
      type: 'response.output_item.done', output_index: textIndex,
      item: { type: 'message', id: `msg_${textIndex}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: textBuf, annotations: [] }] },
    });
  }
  for (const t of toolItems.values()) {
    yield sse('response.function_call_arguments.done', {
      type: 'response.function_call_arguments.done', item_id: t.id, output_index: t.outputIndex, arguments: t.args,
    });
    yield sse('response.output_item.done', {
      type: 'response.output_item.done', output_index: t.outputIndex,
      item: { type: 'function_call', id: t.id, call_id: t.id, name: t.name, arguments: t.args, status: 'completed' },
    });
  }

  yield sse('response.completed', {
    type: 'response.completed',
    response: {
      id: responseId, object: 'response', created_at: createdAt, model: modelId,
      status: STATUS_MAP[finishReason] ?? 'completed',
      output: [], output_text: textBuf,
      usage: {
        input_tokens: usage?.prompt_tokens ?? 0,
        output_tokens: usage?.completion_tokens ?? 0,
        total_tokens: usage?.total_tokens ?? 0,
      },
    },
  });
}

function sse(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
