#!/usr/bin/env node
/**
 * 把已安装的 dsh-workbuddy-trae-qoder-connect 里的 provider 驱动同步到本工程。
 *
 * 为什么不直接从 npm 装：那份驱动只在插件的 lib/ 里，npm 上没有独立包。
 * 插件升级后重跑本脚本即可（原仓库不动）。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const candidates = [
  join(process.env.HOME, '.dsh/profiles/web/node_modules/dsh-workbuddy-trae-qoder-connect'),
  join(process.env.HOME, '.dsh/profiles/headless/node_modules/dsh-workbuddy-trae-qoder-connect'),
];
const source = candidates.find((p) => existsSync(join(p, 'lib/providers/qoder/index.js')));
if (source === undefined) {
  console.error('找不到已安装的 dsh-workbuddy-trae-qoder-connect；先装插件或用 --from <path> 指定');
  process.exit(2);
}
const target = join(root, 'vendor');
mkdirSync(target, { recursive: true });
for (const dir of ['lib/providers:providers', 'lib/shared:shared']) {
  const [from, to] = dir.split(':');
  cpSync(join(source, from), join(target, to), { recursive: true });
}
const version = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')).version;
writeFileSync(join(target, 'SOURCE.json'), JSON.stringify({ source, version, syncedAt: new Date().toISOString() }, null, 2) + '\n');
console.log(`已同步 ${version} → ${target}`);
