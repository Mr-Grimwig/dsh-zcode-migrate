#!/usr/bin/env node
/**
 * 一键安装 / 卸载：给 install.cmd 和 uninstall.cmd 用。
 *
 * 两种跑法：
 *   - 直接双击仓库里的 install.cmd：把当前的 main 分支下载到
 *     %LOCALAPPDATA%\dsh-zcode-migrate，再从那里装进所有 dsh profile。
 *   - 在 clone 出来的仓库里跑：直接用当前目录这份源码安装，不下载。
 *
 * 重复执行就是更新（会重新下载并覆盖本地那份），所以不需要记住别的命令。
 *
 * @module dsh-zcode-migrate/scripts/one-click
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '..');
const REPO = 'Mr-Grimwig/dsh-zcode-migrate';
const BRANCH = 'main';
const TARBALL = `https://codeload.github.com/${REPO}/tar.gz/refs/heads/${BRANCH}`;
const MIN_NODE = [22, 15, 0];

/** 本地保留一份的位置，和用户目录下其他工具放一起。 */
const installDir =
  process.env.LOCALAPPDATA !== undefined
    ? join(process.env.LOCALAPPDATA, 'dsh-zcode-migrate')
    : join(homedir(), '.local', 'share', 'dsh-zcode-migrate');

const args = process.argv.slice(2);
const uninstall = args.includes('--uninstall');

/**
 * 跑一条命令（Windows 上 .cmd 需要 shell，先直接 spawn 再回退）。
 * @param {string} command - 可执行文件。
 * @param {string[]} commandArgs - 参数。
 * @param {string} cwd - 工作目录。
 * @returns {{ status: number|null, stdout: string, stderr: string, missing?: boolean }} 结果。
 */
function run(command, commandArgs, cwd) {
  const options = { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] };
  const direct = spawnSync(command, commandArgs, options);
  if (direct.error === undefined) return direct;
  if (process.platform !== 'win32') return { ...direct, missing: true };
  const viaShell = spawnSync('cmd.exe', ['/d', '/s', '/c', command, ...commandArgs], options);
  return viaShell.error !== undefined ? { ...viaShell, missing: true } : viaShell;
}

/** 找一个能用的 pnpm（dsh plugin 内部也用它）。 */
function findPnpm() {
  if (run('pnpm', ['--version'], process.cwd()).status === 0) return 'pnpm';
  // Node 自带的 corepack 能代跑 pnpm，省得用户自己装。
  if (run('corepack', ['pnpm', '--version'], process.cwd()).status === 0) return 'corepack';
  return undefined;
}

/** 版本比较。 */
function nodeTooOld() {
  const [major, minor, patch] = process.versions.node.split('.').map(Number);
  const [minMajor, minMinor, minPatch] = MIN_NODE;
  if (major !== minMajor) return major < minMajor;
  if (minor !== minMinor) return minor < minMinor;
  return patch < minPatch;
}

/**
 * 解压用的 tar。
 *
 * Windows 上用系统自带的 System32\tar.exe（bsdtar）：PATH 里可能先撞上 Git Bash
 * 的 GNU tar，而它会把 `C:\...` 里的冒号当成远程主机名，报 "Cannot connect to C"。
 */
function findTar() {
  if (process.platform === 'win32') {
    const systemTar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
    if (existsSync(systemTar)) return systemTar;
  }
  return 'tar';
}

/** 下载并解压 main 分支，返回解压出来的包目录。 */
async function download() {
  const tarball = join(tmpdir(), 'dsh-zcode-migrate.tar.gz');
  const extractRoot = join(tmpdir(), 'dsh-zcode-migrate-extract');
  process.stdout.write(`下载 ${TARBALL}\n`);
  const response = await fetch(TARBALL, { redirect: 'follow' });
  if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const { writeFileSync } = await import('node:fs');
  writeFileSync(tarball, bytes);
  process.stdout.write(`下载完成，${(bytes.length / 1024).toFixed(0)} KB，解压中\n`);

  rmSync(extractRoot, { recursive: true, force: true });
  mkdirSync(extractRoot, { recursive: true });
  const tarExe = findTar();
  const tar = run(tarExe, ['-xzf', tarball, '-C', extractRoot], process.cwd());
  if (tar.status !== 0) {
    throw new Error(
      `解压失败（用的 ${tarExe}）。Windows 10 1803 以上自带 tar；如果确实没有，` +
        `可以改用 git clone 之后跑 node scripts/install-into-profile.mjs。\n${tar.stderr ?? ''}`,
    );
  }
  const extracted = join(extractRoot, `${REPO.split('/')[1]}-${BRANCH}`);
  if (!existsSync(join(extracted, 'package.json'))) throw new Error(`解压结果不对：${extracted} 里没有 package.json`);
  return extracted;
}

/**
 * 把源码放到 installDir。
 * @param {string} source - 包目录。
 */
function place(source) {
  rmSync(installDir, { recursive: true, force: true });
  mkdirSync(dirname(installDir), { recursive: true });
  cpSync(source, installDir, { recursive: true });
  process.stdout.write(`已放到 ${installDir}\n`);
}

/**
 * 哪个目录里有可用的 install-into-profile.mjs。
 *
 * 卸载时优先用 %LOCALAPPDATA% 里那份：双击 install.cmd 装的就是它，而单独一个
 * install.cmd 旁边没有源码。
 * @returns {string|undefined} 目录。
 */
function scriptHome() {
  for (const dir of [installDir, packageRoot]) {
    if (existsSync(join(dir, 'scripts', 'install-into-profile.mjs'))) return dir;
  }
  return undefined;
}

process.stdout.write(`\ndsh-zcode-migrate ${uninstall ? '卸载' : '安装'}\n\n`);

if (nodeTooOld()) {
  process.stdout.write(
    `提示：当前 Node 是 ${process.versions.node}，插件需要 ${MIN_NODE.join('.')} 以上。\n` +
      '安装会照常进行，但 DSH 跑在旧 Node 上时插件不会生效。\n\n',
  );
}

if (uninstall) {
  try {
    const home = scriptHome();
    if (home === undefined) {
      throw new Error(
        `找不到 scripts/install-into-profile.mjs（看过 ${installDir} 和 ${packageRoot}）。\n` +
          '可以手动卸载：cd <clone 下来的仓库> && node scripts/install-into-profile.mjs --uninstall',
      );
    }
    const result = run(process.execPath, [join(home, 'scripts', 'install-into-profile.mjs'), '--uninstall'], home);
    process.stdout.write(`${result.stdout ?? ''}`);
    if (result.status !== 0) {
      process.stderr.write(`${result.stderr ?? ''}`);
      throw new Error('卸载没有正常结束');
    }
    if (home === installDir && existsSync(installDir)) {
      rmSync(installDir, { recursive: true, force: true });
      process.stdout.write(`已删除 ${installDir}\n`);
    }
    process.stdout.write('\n完成。\n');
    process.exit(0);
  } catch (error) {
    process.stderr.write(`\n失败：${/** @type {Error} */ (error).message}\n`);
    process.exit(1);
  }
}

const pnpm = findPnpm();
if (pnpm === undefined) {
  process.stderr.write(
    '没有找到 pnpm。DSH 的插件管理本身要用它，请先执行：\n' +
      '  npm install -g pnpm\n' +
      '然后重新运行。\n',
  );
  process.exit(1);
}
if (pnpm === 'corepack') process.stdout.write('未找到 pnpm，将用 corepack 代跑\n');

try {
  // 在 clone 里跑就用这份源码，单独一个 install.cmd 则先下载一份。
  const insideClone = existsSync(join(packageRoot, 'src', 'index.js')) && existsSync(join(packageRoot, 'lib', 'index.js'));
  const source = insideClone ? packageRoot : await download();
  if (!insideClone) place(source);

  // 从落盘的那份安装，这样以后重新下载就能覆盖更新。
  const target = insideClone ? packageRoot : installDir;
  const scriptTarget = join(target, 'scripts', 'install-into-profile.mjs');
  if (!existsSync(scriptTarget)) throw new Error(`找不到安装脚本：${scriptTarget}`);
  const result = run(process.execPath, [scriptTarget], target);
  process.stdout.write(`${result.stdout ?? ''}`);
  if (result.status !== 0) {
    process.stderr.write(`${result.stderr ?? ''}`);
    throw new Error('安装没有完成');
  }
  process.stdout.write('\n完成。\n');
} catch (error) {
  process.stderr.write(`\n失败：${/** @type {Error} */ (error).message}\n`);
  process.stderr.write(`也可以手动安装：git clone https://github.com/${REPO}.git 之后跑 node scripts/install-into-profile.mjs\n`);
  process.exit(1);
}
