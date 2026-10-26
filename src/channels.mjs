/**
 * 四条渠道的装配 —— 复用插件里的 provider 驱动，不自造协议。
 *
 * 每个渠道最终给出 { id, label, models(), shim }，shim 是插件自带的 OpenAI 兼容
 * 回环服务（/v1/models + /v1/chat/completions，SSE 流式）。
 * bearer 由 shim 自己随机生成，我们直接持有它的 token()，不落盘。
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * DSH_HOME 优先 —— 容器里 HOME 是 /root，凭据却挂在 /dsh，
 * 只认 HOME 会在容器里静默读不到目录缓存（表现为模型数掉回 fallback）。
 */
const DSH_HOME = process.env.DSH_HOME?.trim() || join(process.env.HOME ?? homedir(), '.dsh');

import * as qoder from '../vendor/providers/qoder/index.js';
import * as trae from '../vendor/providers/trae/index.js';
import * as workbuddy from '../vendor/providers/workbuddy/index.js';
import * as variants from '../vendor/providers/workbuddy/variants-CnrmSn0Q.js';

const silent = { info() {}, debug() {}, warn() {}, error() {} };

/** Trae 的产品表（CN 单产品）；shim 要用它解析 model id 的 function 前缀。 */
const TRAE_PRODUCTS = {
  cn: { id: 'cn', label: 'Trae CN（IDE）', functions: ['solo_agent'], defaultFunction: 'solo_agent' },
};

/** workbuddy 的变体表是压缩过的具名导出，兼容两种取名方式。 */
const variantTable = variants.WORKBUDDY_VARIANTS ?? variants.r ?? [];
const variantFor = (id) => (variants.i ? variants.i(id) : variantTable.find((v) => v.id === id));

/** 国区/国际版两个 workbuddy 槽位，只启用在 ~/.dsh 下有凭据的。 */
function workbuddyChannels(logger) {
  const out = [];
  for (const id of ['workbuddy1', 'workbuddy4']) {
    const variant = variantFor(id);
    if (variant === undefined) continue;
    const client = new workbuddy.WorkBuddyUpstreamClient();
    /**
     * desktopPath 必须显式传：插件在 DSH 里由 configuredAuthFile() 算出来再注入，
     * 我们脱离宿主自己装配，不传就会退回**平台默认的桌面 App 路径**
     * （macOS 的 CodeBuddyExtension、容器里的 /root/.config），于是
     * connect-auth/<id>.json 里现成的明文快照完全读不到 —— 表现为
     * "no signed-in WorkBuddy AI account found"。
     */
    /**
     * 两种落盘格式必须分清（踩过）：
     *   · connect-auth/<id>.json      = 插件自有副本 {version, credential:{...}}
     *   · WorkBuddy 桌面 App 的 .info  = 桌面格式 {auth:{accessToken,...}, account:{uid,...}}
     * desktopPath 走的是**桌面格式解析**（parseWorkBuddyAuth），把自有副本塞给它
     * 会解析不出 accessToken，直接报 "no signed-in WorkBuddy AI account found"。
     * 所以这里按格式判断：桌面格式 → desktopPath；自有副本 → ownPath。
     */
    const explicit = join(DSH_HOME, 'connect-auth', `${id}.json`);
    const snapshot = readSnapshot(explicit);
    const store = new workbuddy.WorkBuddyCredentialStore({
      variant,
      ...(snapshot?.kind === 'desktop' ? { desktopPath: explicit } : {}),
      ...(snapshot?.kind === 'own' ? { ownPath: explicit } : {}),
      refresh: (credential) => client.refreshToken(credential),
    });
    const fallback = variant.region === 'global'
      ? workbuddy.FALLBACK_WORKBUDDY_AI_MODELS
      : workbuddy.FALLBACK_WORKBUDDY_MODELS;
    const catalog = new workbuddy.WorkBuddyCatalog(fallback);
    // 早先本工程把已抓到的目录缓存在 ~/.dsh/.<id>-catalog.json，直接接上，省一次上游拉取
    // 缓存文件是 {version, entries:{<account>:{models:[...]}}}；不按 account 也能用，
    // 因为一台机器上那种成品目录通常只有一条。取"最新 fetchedAtMs"的那条更稳。
    const saved = new workbuddy.WorkBuddyCatalogStore(join(DSH_HOME, `.${id}-catalog.json`));
    const entries = Object.values(saved.load?.() ?? {});
    const newest = entries.filter((e) => Array.isArray(e?.models) && e.models.length > 0)
      .sort((a, b) => (b.fetchedAtMs ?? 0) - (a.fetchedAtMs ?? 0))[0];
    if (newest !== undefined) catalog.set(newest.models.map((m) => (typeof m === 'string' ? { id: m } : m)));
    out.push({ id, label: variant.displayName ?? id, region: variant.region ?? 'cn', kind: 'workbuddy', store, client, catalog, logger });
  }
  return out;
}

/** 判断 connect-auth 里的快照是桌面格式还是插件自有副本格式。 */
function readSnapshot(path) {
  if (!existsSync(path)) return undefined;
  try {
    const doc = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof doc?.auth?.accessToken === 'string') return { kind: 'desktop' };
    if (typeof doc?.credential?.accessToken === 'string') return { kind: 'own' };
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * 发现 Qoder 账号槽位。
 *
 * 约定优于配置：主账号永远叫 `qoder`（qoder-session.json），二号起叫 `qoder2`…
 * （qoder-session-2.json …）。存在才启用，坏 JSON 跳过并告警 —— 一个账号过期
 * 不能把整个渠道拖死。
 */
function qoderAccountSlots() {
  const authDir = join(DSH_HOME, 'connect-auth');
  const slots = [];
  for (const suffix of ['', '-2', '-3', '-4', '-5']) {
    const file = join(authDir, `qoder-session${suffix}.json`);
    if (!existsSync(file)) continue;
    try {
      const doc = JSON.parse(readFileSync(file, 'utf8'));
      if (typeof doc?.token !== 'string' || doc.token === '') continue;
      const n = suffix === '' ? '' : suffix.slice(1);
      slots.push({
        id: `qoder${n}`,
        label: `Qoder CN${suffix === '' ? '' : `（账号 ${n}）`}`,
        file,
        account: doc.name ?? doc.email ?? doc.uid ?? '',
      });
    } catch {
      // 坏 JSON → 跳过该槽位，不影响其它账号
    }
  }
  return slots;
}

export async function startChannels({ logger = silent } = {}) {
  const started = [];

  // —— Qoder CN：支持多账号 ——
  /**
   * 插件把 qoder 定为单实例（provider 路由/状态文件单例写死），但那是**宿主装配**
   * 的约束，不是协议约束：上游只认「一份会话凭据 → 一个 jobToken → 一条 SSE 链」。
   * 本工程自己装配，所以每个账号起一套独立的 store/token/catalog/shim，
   * 模型 id 用 `qoder/…`、`qoder2/…` 区分。
   *
   * 账号发现规则：`$DSH_HOME/connect-auth/qoder-session.json` 是 1 号（主账号）；
   * `qoder-session-2.json`…`qoder-session-9.json` 存在即追加为 2~9 号。
   * 也可以在 env 里用 QODER_ACCOUNTS="qoder,qoder2" 显式点名（文件不存在就跳过）。
   */
  const qoderSlots = qoderAccountSlots();
  for (const slot of qoderSlots) {
    const cfg = () => ({ sessionFile: slot.file });
    const pats = qoder.createPatStore({ config: cfg });
    const sessions = qoder.createSessionStore({ config: cfg });
    const tokens = qoder.createTokenManager({ pats, sessions, config: cfg, logger });
    const catalog = qoder.createCatalog({ tokens, config: cfg, logger });
    const client = qoder.createQoderClient({ tokens, config: cfg, logger });
    const shim = qoder.createQoderShim({ client, catalog, logger });
    await shim.ready;
    await catalog.reload().catch((e) => logger.warn?.(`${slot.id} 目录拉取失败：${e.message}`));
    const n = catalog.current().length;
    logger.info?.(`qoder 槽位 ${slot.id} 就绪（${n} 个模型，${slot.file.split('/').pop()}）`);
    started.push({ id: slot.id, label: slot.label, kind: 'qoder', shim, catalog });
  }

  // —— Trae CN ——
  const traeStore = trae.createCredentialStore({ config: () => ({}) });
  const traeCatalog = trae.createCatalog({ store: traeStore, config: () => ({}), logger });
  const traeClient = trae.createTraeClient({ store: traeStore, config: () => ({}), logger });
  /**
   * shim 每次请求都调 options.settings() 解析 product/function —— 解不出来
   * 就是 `TypeError: options.settings is not a function`（401/500 都可能）。
   * DSH 里这份闭包由 apply() 提供，我们脱离宿主必须自己给。
   * 值取自 Trae CN IDE 的快照：产品 cn，function 用 solo_agent（IDE 内模式）。
   */
  const traeSettings = () => {
    const product = TRAE_PRODUCTS.cn;
    const wanted = 'solo_agent';
    return {
      product: product.id,
      productLabel: product.label,
      function: product.functions.includes(wanted) ? wanted : product.defaultFunction,
      functions: product.functions,
    };
  };
  const traeShim = trae.createTraeShim({ store: traeStore, client: traeClient, catalog: traeCatalog, settings: traeSettings, logger });
  await traeShim.ready;
  started.push({ id: 'trae', label: 'Trae CN', kind: 'trae', shim: traeShim, catalog: traeCatalog });

  // —— WorkBuddy 国区 / 国际版 ——
  for (const c of workbuddyChannels(logger)) {
    const shim = workbuddy.createWorkBuddyShim({ store: c.store, client: c.client, catalog: c.catalog, logger });
    await shim.ready;
    started.push({ id: c.id, label: c.label, kind: 'workbuddy', region: c.region, shim, catalog: c.catalog });
  }

  return {
    channels: started,
    close: async () => { for (const c of started) await c.shim.close?.(); },
  };
}
