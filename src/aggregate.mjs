/**
 * 把插件的 SSE 流汇总成一个 chat.completion 对象。
 *
 * 为什么需要：三个 shim 都**无视 `stream:false`**，一律返回 SSE
 * （实测 qoder/workbuddy 都是 `data: {...}` 分片）。所以客户端要非流式时，
 * 必须在本地按分片语义重组，不能指望上游给整包 JSON。
 */
export async function sseToChatCompletion(stream) {
  const result = { id: undefined, model: undefined, created: undefined, choices: [{ index: 0, message: { role: 'assistant', content: '', tool_calls: [] }, finish_reason: null }], usage: undefined };
  const message = result.choices[0].message;
  const tools = new Map();

  const reader = stream.getReader();
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
        result.id ??= chunk.id;
        result.model ??= chunk.model;
        result.created ??= chunk.created;
        const choice = chunk.choices?.[0];
        if (choice === undefined) continue;
        const delta = choice.delta ?? {};
        if (typeof delta.reasoning_content === 'string') message.reasoning_content = (message.reasoning_content ?? '') + delta.reasoning_content;
        if (typeof delta.content === 'string') message.content += delta.content;
        for (const call of delta.tool_calls ?? []) {
          const key = call.index ?? 0;
          if (!tools.has(key)) tools.set(key, { id: call.id, type: 'function', function: { name: call.function?.name ?? '', arguments: '' } });
          const t = tools.get(key);
          if (call.id !== undefined) t.id ??= call.id;
          if (call.function?.name !== undefined && t.function.name === '') t.function.name = call.function.name;
          if (typeof call.function?.arguments === 'string') t.function.arguments += call.function.arguments;
        }
        if (typeof choice.finish_reason === 'string' && choice.finish_reason !== '') result.choices[0].finish_reason = choice.finish_reason;
        if (chunk.usage !== undefined) result.usage = chunk.usage;
      }
    }
  } finally {
    reader.releaseLock();
  }

  if (tools.size > 0) message.tool_calls = [...tools.values()];
  else delete message.tool_calls;
  if (message.content === '') delete message.content;
  if (message.reasoning_content === undefined) delete message.reasoning_content;
  result.id ??= `chatcmpl-${Date.now().toString(36)}`;
  result.object = 'chat.completion';
  result.created ??= Math.floor(Date.now() / 1000);
  return result;
}
