#!/usr/bin/env node
/**
 * dsh-model-bridge —— 把四路渠道桥接给 Codex 与 Claude Code。
 *
 * 三条对外面（同一个端口）：
 *   /v1/responses            ← Codex（Responses 方言）
 *   /v1/messages             ← Claude Code（Anthropic Messages 方言）
 *   /v1/chat/completions     ← 原样透传（备用/自测）
 *   /v1/models               ← 两边都读它拿模型表
 *
 * 上游是插件自带的回环 shim（OpenAI chat completions），本进程只做协议翻译。
 * bearer：对外用本地 token（默认自动生成到 ~/.dsh-model-bridge/token，0600），
 * 上游用 shim 自己的随机 token —— 两者都由本进程持有，不落盘明文日志。
 */
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { timingSafeEqual } from 'node:crypto';

import { startChannels } from './channels.mjs';
import { buildRegistry, resolveModel } from './registry.mjs';
import { toOpenAIBody, toAnthropicMessage, toAnthropicStream } from './anthropic.mjs';
import { toChatBody, toResponsesObject, toResponsesStream } from './responses.mjs';
import { sseToChatCompletion } from './aggregate.mjs';

const HOME = process.env.HOME ?? homedir();
const PORT = Number(process.env.BRIDGE_PORT ?? 18780);
const HOST = process.env.BRIDGE_HOST ?? '127.0.0.1';

/**
 * 对外 token。
 *
 * 优先级：BRIDGE_TOKEN 环境变量 → ~/.dsh-model-bridge/token → 新生成。
 * 容器里 /dsh 可能是只读挂载，所以必须支持直接给 token（否则落盘失败）。
 */
function loadToken() {
  const fromEnv = process.env.BRIDGE_TOKEN?.trim();
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  const dir = join(HOME, '.dsh-model-bridge');
  const file = join(dir, 'token');
  if (existsSync(file)) {
    const t = readFileSync(file, 'utf8').trim();
    if (t !== '') return t;
  }
  const token = `brg-${randomBytes(24).toString('base64url')}`;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(file, token + '\n', { mode: 0o600 });
  } catch {
    // 只读挂载 → 本次用生成的 token，日志里提示改用 BRIDGE_TOKEN
    console.warn('[bridge] 无法写入 token 文件（只读挂载？），本次使用临时 token；如需固定请设 BRIDGE_TOKEN');
  }
  return token;
}

const TOKEN = loadToken();

const logger = {
  info: (m) => console.log(`[bridge] ${m}`),
  warn: (m) => console.warn(`[bridge] ${m}`),
  error: (m) => console.error(`[bridge] ${m}`),
  debug: () => {},
};

function authorized(req) {
  const header = req.headers.authorization ?? '';
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  const given = m?.[1] ?? (req.headers['x-api-key']); // Anthropic 客户端用 x-api-key
  if (typeof given !== 'string') return false;
  const a = Buffer.from(given), b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function openaiError(res, status, message, code = 'invalid_request_error') {
  json(res, status, { error: { message, type: code, code } });
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (chunks.length === 0) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return undefined; }
}

/** 把请求转给上游 shim，返回原始 fetch Response。 */
async function callUpstream(channel, body) {
  const url = `${channel.shim.baseUrl()}/v1/chat/completions`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: body.stream ? 'text/event-stream' : 'application/json', authorization: `Bearer ${channel.shim.token()}` },
    body: JSON.stringify(body),
  });
  return r;
}

const { channels, close } = await startChannels({ logger });
const registry = buildRegistry(channels);
logger.info(`渠道 ${channels.length} 个：${channels.map((c) => `${c.id}(${c.catalog?.current?.().length ?? 0})`).join(' ')}`);
logger.info(`模型 ${registry.length} 个`);

/** 上游返回的可能是 SSE 也可能是 JSON，按 content-type 判，不要猜。 */
function isEventStream(response) {
  return (response.headers.get('content-type') ?? '').includes('text/event-stream');
}

const server = createServer(async (req, res) => {
  try {
    const url = (req.url ?? '/').split('?')[0].replace(/\/+$/, '') || '/';
    if (req.method === 'GET' && (url === '/healthz' || url === '/')) {
      return json(res, 200, { ok: true, channels: channels.map((c) => ({ id: c.id, models: c.catalog?.current?.().length ?? 0 })), models: registry.length });
    }
    if (!authorized(req)) return openaiError(res, 401, 'invalid api key', 'authentication_error');

    if (req.method === 'GET' && url === '/v1/models') {
      return json(res, 200, {
        object: 'list',
        data: registry.map((e) => ({ id: e.id, object: 'model', created: 0, owned_by: e.channel })),
        // Anthropic 客户端读 models 时用这个形状；多给一份不冲突
        first_id: registry[0]?.id ?? null,
        has_more: false,
        last_id: registry.at(-1)?.id ?? null,
      });
    }

    const body = await readBody(req);
    if (body === undefined) return openaiError(res, 400, 'invalid JSON body');
    if (process.env.BRIDGE_DEBUG === '1') {
      logger.info(`${req.method} ${url} model=${JSON.stringify(body.model)} stream=${String(body.stream)} keys=${Object.keys(body).join(',')}`);
    }

    // —— 原样透传 ——
    if (req.method === 'POST' && url === '/v1/chat/completions') {
      const model = resolveModel(registry, String(body.model ?? ''));
      if (model === undefined) return openaiError(res, 404, `unknown model: ${body.model}`, 'model_not_found');
      const channel = channels.find((c) => c.id === model.channel);
      const up = await callUpstream(channel, { ...body, model: model.upstreamModel });
      if (isEventStream(up)) {
        // 上游无视 stream:false，非流式请求要在本地汇总
        if (body.stream !== true) return json(res, 200, await sseToChatCompletion(up.body));
        res.writeHead(up.status, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
        const reader = up.body.getReader();
        for (;;) { const { value, done } = await reader.read(); if (done) break; res.write(value); }
        return res.end();
      }
      res.writeHead(up.status, { 'content-type': up.headers.get('content-type') ?? 'application/json' });
      return res.end(Buffer.from(await up.arrayBuffer()));
    }

    // —— Codex：Responses 方言 ——
    if (req.method === 'POST' && (url === '/v1/responses' || url === '/responses')) {
      const model = resolveModel(registry, String(body.model ?? ''));
      if (model === undefined) return openaiError(res, 404, `unknown model: ${body.model}`, 'model_not_found');
      const channel = channels.find((c) => c.id === model.channel);
      const up = await callUpstream(channel, toChatBody(body, model.upstreamModel));
      if (!up.ok && !isEventStream(up)) {
        const err = await up.text();
        return openaiError(res, up.status, `upstream ${up.status}: ${err.slice(0, 500)}`, 'upstream_error');
      }
      if (body.stream === true) {
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
        for await (const ev of toResponsesStream(up.body, model.id)) res.write(ev);
        return res.end();
      }
      const payload = isEventStream(up) ? await sseToChatCompletion(up.body) : await up.json();
      return json(res, 200, toResponsesObject(payload, model.id));
    }

    // —— Claude Code：Anthropic Messages 方言 ——
    if (req.method === 'POST' && (url === '/v1/messages' || url === '/messages')) {
      const model = resolveModel(registry, String(body.model ?? ''));
      if (model === undefined) {
        return json(res, 404, { type: 'error', error: { type: 'not_found_error', message: `unknown model: ${body.model}` } });
      }
      const channel = channels.find((c) => c.id === model.channel);
      const up = await callUpstream(channel, toOpenAIBody(body, model.upstreamModel));
      if (!up.ok && !isEventStream(up)) {
        const err = await up.text();
        return json(res, up.status, { type: 'error', error: { type: 'api_error', message: `upstream ${up.status}: ${err.slice(0, 500)}` } });
      }
      if (body.stream === true) {
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
        for await (const ev of toAnthropicStream(up.body, model.id)) res.write(ev);
        return res.end();
      }
      const payload = isEventStream(up) ? await sseToChatCompletion(up.body) : await up.json();
      return json(res, 200, toAnthropicMessage(payload, model.id));
    }

    // Anthropic 客户端会探这个（token 计数），给个不报错的空壳
    if (req.method === 'POST' && url === '/v1/messages/count_tokens') {
      const body2 = await readBody(req);
      const text = JSON.stringify(body2 ?? '');
      return json(res, 200, { input_tokens: Math.ceil(text.length / 4) });
    }

    return openaiError(res, 404, `no such route: ${req.method} ${url}`, 'not_found');
  } catch (error) {
    logger.error(`请求失败：${error?.stack ?? error}`);
    if (!res.headersSent) return openaiError(res, 500, String(error?.message ?? error), 'internal_error');
    res.end();
  }
});

server.listen(PORT, HOST, () => {
  logger.info(`listening on http://${HOST}:${PORT}`);
  logger.info(`token 在 ~/.dsh-model-bridge/token`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    logger.info('shutting down');
    server.close();
    await close();
    process.exit(0);
  });
}
