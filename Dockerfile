# dsh-model-bridge —— 把 WorkBuddy / Trae / Qoder 的免费额度桥接给 Codex 与 Claude Code
#
# 只读挂载 ~/.dsh 里的凭据目录，容器内不落任何账号数据。
FROM node:22-alpine

WORKDIR /app

COPY package.json ./
COPY vendor ./vendor
COPY src ./src
COPY scripts ./scripts

# 只用生产依赖；vendor 里的驱动是插件原样副本，不需要再装 DSH 本体
RUN npm install --omit=dev --no-audit --no-fund

ENV BRIDGE_HOST=0.0.0.0 \
    BRIDGE_PORT=18780 \
    DSH_HOME=/dsh

EXPOSE 18780

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.BRIDGE_PORT||18780)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/bridge.mjs"]
