#!/usr/bin/env node
/**
 * 把本插件装进 dsh profile。
 *
 * 不带参数就装到 <DSH 主目录>/profiles 下所有已存在的 profile；也可以用
 * --profile=web 指定其中一个。
 *
 * 包内声明了 dsh.bundle.patch，所以 `dsh plugin add` 会同时完成两件事：把依赖
 * 装进 profile，并把这个包加入该 profile 的 dsh.profile.bundles。脚本优先走
 * dsh 命令，取不到 dsh 时用 pnpm 加上直接改 bundles 列表。装完会核对依赖和
 * 插件层都在，而不是只看退出码。
 *
 * 更新必须"先 remove 再 add"：file: 依赖在 pnpm 里是硬链接快照，同一个 spec
 * 重复 add 会被判成已经最新而不重新拷贝。脚本内部就是这么处理的。
 *
 * @module dsh-zcode-migrate/scripts/install-into-profile
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { resolveDshHome } from '../src/core/config.js';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '..');
const packageName = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).name;
const dshHome = resolveDshHome(undefined, process.env);

/**
 * 解析 --key=value / --flag。
 * @param {string[]} argv - 参数。
 * @returns {Record<string, string|boolean>} 结果。
 */
function parse(argv) {
  const flags = {};
  for (const token of argv) {
    if (!token.startsWith('--')) continue;
    const body = token.slice(2);
    const eq = body.indexOf('=');
    if (eq === -1) flags[body] = true;
    else flags[body.slice(0, eq)] = body.slice(eq + 1);
  }
  return flags;
}

/** 本机上已存在的 profile 名字。 */
function listProfiles() {
  const root = join(dshHome, 'profiles');
  if (!existsSync(root)) return [];
  return readdirSync(root).filter((name) => {
    const dir = join(root, name);
    try {
      return statSync(dir).isDirectory() && existsSync(join(dir, 'package.json'));
    } catch {
      return false;
    }
  });
}

/**
 * 跑一条命令。Windows 上 .cmd 需要 shell，所以先直接 spawn，失败再走 cmd.exe。
 * @param {string} command - 可执行文件。
 * @param {string[]} args - 参数。
 * @param {string} cwd - 工作目录。
 * @returns {{ status: number|null, stdout: string, stderr: string }} 结果。
 */
function run(command, args, cwd) {
  const options = { cwd, encoding: 'utf8' };
  const direct = spawnSync(command, args, options);
  if (direct.error === undefined) return direct;
  if (process.platform !== 'win32') return direct;
  return spawnSync('cmd.exe', ['/d', '/s', '/c', command, ...args], options);
}

/** dsh 启动器；取不到就返回 undefined，让调用方回退到 pnpm。 */
function findDsh() {
  if (run('dsh', ['--version'], process.cwd()).status === 0) return 'dsh';
  for (const anchor of [join(process.cwd(), 'package.json'), join(packageRoot, 'package.json')]) {
    try {
      return createRequire(anchor).resolve('@deepseek-ai/dsh/lib/bin.js');
    } catch {
      /* 试下一个位置 */
    }
  }
  return undefined;
}

const dsh = findDsh();

/**
 * 通过 dsh 命令做一件事。
 * @param {string} profileName - profile 名。
 * @param {'add'|'remove'} verb - 动作。
 * @returns {{ ok: boolean, output: string }} 结果。
 */
function viaDsh(profileName, verb) {
  const args = ['plugin', `--profile=${profileName}`, verb, verb === 'add' ? `file:${packageRoot}` : packageName];
  const result = dsh.endsWith('.js') ? run(process.execPath, [dsh, ...args], process.cwd()) : run(dsh, args, process.cwd());
  return { ok: result.status === 0, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

/**
 * 通过 pnpm 加改清单做一件事。
 * @param {string} profileName - profile 名。
 * @param {'add'|'remove'} verb - 动作。
 * @returns {{ ok: boolean, output: string }} 结果。
 */
function viaPnpm(profileName, verb) {
  const profileDir = join(dshHome, 'profiles', profileName);
  const spec = verb === 'add' ? `file:${packageRoot}` : packageName;
  const result = run('pnpm', [verb, spec], profileDir);
  if (result.status !== 0) return { ok: false, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };

  const manifestPath = join(profileDir, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const bundles = manifest.dsh?.profile?.bundles;
  if (!Array.isArray(bundles)) return { ok: false, output: 'profile 清单缺少 dsh.profile.bundles' };
  const has = bundles.includes(packageName);
  if (verb === 'add' && !has) bundles.push(packageName);
  if (verb === 'remove' && has) bundles.splice(bundles.indexOf(packageName), 1);
  manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh.profile, bundles } };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return { ok: true, output: '' };
}

/**
 * 装或卸一个 profile。
 * @param {string} profileName - profile 名。
 * @param {'add'|'remove'} verb - 动作。
 * @returns {string} 一行结果。
 */
function apply(profileName, verb) {
  if (dsh !== undefined) {
    if (verb === 'add') {
      // 更新要走 remove + add，见文件头说明。首次安装时 remove 会失败，无所谓。
      viaDsh(profileName, 'remove');
      const added = viaDsh(profileName, 'add');
      if (!added.ok) throw new Error(`dsh 安装失败：\n${added.output}`);
    } else {
      const removed = viaDsh(profileName, 'remove');
      if (!removed.ok && !/not found|no such|ERR_PNPM/i.test(removed.output)) {
        throw new Error(`dsh 卸载失败：\n${removed.output}`);
      }
    }
  } else {
    if (verb === 'add') {
      viaPnpm(profileName, 'remove');
      const added = viaPnpm(profileName, 'add');
      if (!added.ok) throw new Error(`pnpm 安装失败：\n${added.output}`);
    } else {
      const removed = viaPnpm(profileName, 'remove');
      if (!removed.ok) throw new Error(`pnpm 卸载失败：\n${removed.output}`);
    }
  }

  // 核对结果，而不是相信退出码。
  const dir = join(dshHome, 'profiles', profileName);
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const installed = { ...(manifest.dependencies ?? {}), ...(manifest.devDependencies ?? {}) }[packageName];
  const isLayer = (manifest.dsh?.profile?.bundles ?? []).includes(packageName);

  if (verb === 'remove') {
    if (installed !== undefined || isLayer) throw new Error('卸载后仍有残留');
    return `${profileName}：已卸载`;
  }
  if (installed === undefined) throw new Error(`依赖没写进 ${dir}\\package.json，可以手动执行：cd "${dir}" && pnpm add file:${packageRoot}`);
  if (!isLayer) throw new Error('依赖装上了但没进插件层（dsh.profile.bundles 里没有它），确认 package.json 里声明了 dsh.bundle.patch');
  return `${profileName}：已安装（依赖 ${installed}，已在插件层列表里）`;
}

const flags = parse(process.argv.slice(2));
const uninstall = flags.uninstall === true;
const targets = typeof flags.profile === 'string' ? [flags.profile] : listProfiles();

if (targets.length === 0) {
  process.stderr.write(
    `没有找到 dsh profile（在 ${join(dshHome, 'profiles')} 下）。\n` +
      '先确认 DSH 装过并启动过一次，或者用 --profile=<名字> 指定。\n' +
      `零安装试跑可以不走 profile：dsh --patch "${join(packageRoot, 'cordis.patch.yml')}"\n`,
  );
  process.exit(1);
}

const lines = [];
let failed = 0;
for (const profileName of targets) {
  try {
    lines.push(apply(profileName, uninstall ? 'remove' : 'add'));
  } catch (error) {
    failed += 1;
    lines.push(`${profileName}：失败 —— ${/** @type {Error} */ (error).message}`);
  }
}

process.stdout.write(`${lines.join('\n')}\n`);
if (failed > 0) process.exit(1);

if (uninstall) process.exit(0);

process.stdout.write(
  [
    '',
    '重启 DSH 即可，之后不用再管：每次启动会自动把 ZCode 侧的新增内容补齐。',
    '想手动同步时在会话里发 /zcode-import（不加参数）。',
    '',
  ].join('\n'),
);
