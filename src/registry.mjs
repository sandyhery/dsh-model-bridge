/**
 * 统一模型表 —— 把四条渠道的模型 id 摊平成 `渠道/模型` 形式。
 *
 * 为什么加前缀：四家 id 有重名（deepseek-v4.1-flash 在国区和国际版都存在，
 * 但倍率/上下文/上游都不同），不加前缀客户端会选错渠道。
 */
export function buildRegistry(channels) {
  const entries = [];
  for (const channel of channels) {
    const models = channel.catalog?.current?.() ?? [];
    for (const model of models) {
      const id = String(model.id ?? '');
      if (id === '') continue;
      entries.push({
        // 对外 id：Claude Code / Codex 都按它选模型
        id: `${channel.id}/${id}`,
        channel: channel.id,
        upstreamModel: id,
        name: model.name ?? id,
        rate: model.credits ?? model.rate ?? undefined,
        contextWindow: model.contextWindow ?? model.supportedContextWindows?.[0],
        maxTokens: model.maxTokens,
        supportsImages: model.supportsImages === true,
      });
    }
  }
  return entries;
}

/** 客户端可能给裸 id（不带渠道前缀），此时按唯一匹配回填。 */
export function resolveModel(registry, requested) {
  const exact = registry.find((e) => e.id === requested);
  if (exact !== undefined) return exact;
  const bare = registry.filter((e) => e.upstreamModel === requested);
  if (bare.length === 1) return bare[0];
  if (bare.length > 1) return undefined; // 重名 → 要求客户端指定前缀
  return undefined;
}
