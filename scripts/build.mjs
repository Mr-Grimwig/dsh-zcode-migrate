#!/usr/bin/env node
/**
 * Build: verify, then emit `lib/`.
 *
 * The plugin ships as plain ESM with no runtime dependencies, so "building"
 * means three things that are worth doing anyway (AC-4):
 *
 * 1. **Syntax-check every module** (`node --check`) — a parse error must fail
 *    the build, not the first import inside a user's harness.
 * 2. **Import every module except the plugin entry** — catches a broken
 *    relative import or a stray bare specifier that would only surface at
 *    runtime. The entry is excluded because it probes for
 *    `@deepseek-ai/schemastery`, which need not exist outside a harness.
 * 3. **Copy `src/` to `lib/`** and write a manifest of what was produced, so a
 *    deployment can be diffed against its source.
 *
 * It also asserts the plugin inventory is complete (AC-4): `package.json` must
 * declare the plugin entry and the patch file must exist and name the plugin.
 *
 * @module dsh-zcode-migrate/scripts/build
 */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const srcDir = join(root, 'src');
const libDir = join(root, 'lib');

/** Every `.js` file under a directory, recursively. */
function collectJs(dir) {
  /** @type {string[]} */
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectJs(path));
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(path);
  }
  return out.sort();
}

/** Fail the build with a readable message. */
function fail(message) {
  process.stderr.write(`构建失败：${message}\n`);
  process.exit(1);
}

const files = collectJs(srcDir);
if (files.length === 0) fail('src/ 下没有找到任何模块');

// 1. syntax
let checked = 0;
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    fail(`语法检查未通过：${relative(root, file)}\n${result.stderr}`);
  }
  checked += 1;
}

// 2. imports (the plugin entry is exempt: it probes for harness packages)
const entry = join(srcDir, 'index.js');
let imported = 0;
for (const file of files) {
  if (file === entry) continue;
  const script = `import(${JSON.stringify(new URL(`file://${file}`).href)}).then(()=>{}, (error)=>{ console.error(error?.stack ?? String(error)); process.exit(1); });`;
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], { encoding: 'utf8' });
  if (result.status !== 0) {
    fail(`模块导入失败：${relative(root, file)}\n${result.stderr}`);
  }
  imported += 1;
}

// 3. plugin inventory (AC-4)
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
if (pkg.main !== 'lib/index.js') fail(`package.json 的 main 应为 lib/index.js，实际为 ${String(pkg.main)}`);
if (pkg.type !== 'module') fail('package.json 的 type 应为 module');
// The layer declaration is what lets `dsh plugin --profile <n> add` activate the
// patch automatically; without it the install becomes a manual patch edit.
if (pkg.dsh?.bundle?.patch !== './cordis.patch.yml') {
  fail('package.json 必须声明 dsh.bundle.patch 为 ./cordis.patch.yml（否则安装后不会加入插件层）');
}
const patchPath = join(root, 'cordis.patch.yml');
if (!existsSync(patchPath)) fail('缺少 cordis.patch.yml');
const patch = readFileSync(patchPath, 'utf8');
if (!patch.includes("name: 'dsh-zcode-migrate'")) fail('cordis.patch.yml 未声明本插件的 name');
if (!patch.includes('- insert:')) fail('cordis.patch.yml 缺少 insert 段');
if (!patch.includes('id: zcode-migrate')) fail('cordis.patch.yml 缺少行 id');
const docs = ['docs/需求说明书.md', 'README.md'];
for (const doc of docs) {
  if (!existsSync(join(root, doc))) fail(`缺少文档 ${doc}`);
}

// 一键安装包：两个 .cmd 是给双击用的门面，真正的逻辑在 one-click.mjs。
for (const [cmd, script] of [['install.cmd', 'one-click.mjs'], ['uninstall.cmd', 'one-click.mjs']]) {
  const cmdPath = join(root, cmd);
  if (!existsSync(cmdPath)) fail(`缺少 ${cmd}`);
  const text = readFileSync(cmdPath, 'utf8');
  if (!text.includes(script)) fail(`${cmd} 没有调用 ${script}`);
  if (!text.includes('chcp 65001')) fail(`${cmd} 缺少 chcp 65001（node 输出的中文会乱码）`);
  if (!text.includes('curl -fsSL')) fail(`${cmd} 缺少下载引导（用户可能只下载了这一个文件）`);
  // 这两行都不是洁癖：cmd.exe 按块读批处理，LF 结尾时会在块边界把命令切坏，而
  // GitHub 的 raw 下载会把 CRLF 转成 LF。所以文件必须小到能落在一个块里。
  const lfBytes = Buffer.byteLength(text.replace(/\r\n/g, '\n'), 'utf8');
  if (lfBytes >= 512) {
    fail(`${cmd} 去掉换行后必须小于 512 字节（现在是 ${lfBytes}），否则用户从 raw 下载到的 LF 版本会被 cmd.exe 切坏`);
  }
  if (!text.includes('\r\n')) fail(`${cmd} 在仓库里请用 CRLF 存盘`);
}
if (!existsSync(join(root, 'scripts', 'one-click.mjs'))) fail('缺少 scripts/one-click.mjs');

// 4. emit lib/
rmSync(libDir, { recursive: true, force: true });
mkdirSync(libDir, { recursive: true });
cpSync(srcDir, libDir, { recursive: true });

const manifest = {
  name: pkg.name,
  version: pkg.version,
  // No build timestamp: it would make every rebuild look like a change.
  modules: files.map((file) => ({
    path: relative(srcDir, file).split('\\').join('/'),
    bytes: statSync(file).size,
  })),
  checks: { syntaxChecked: checked, importsVerified: imported, entryExempt: 'src/index.js' },
};
writeFileSync(join(libDir, 'build-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

process.stdout.write(
  `构建完成：${files.length} 个模块（语法 ${checked}，导入 ${imported}）→ ${relative(root, libDir)}/\n`,
);
