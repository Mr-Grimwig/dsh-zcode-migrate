/**
 * Push the current commit through GitHub's Git Data API.
 *
 * Needed only because `github.com:443` (the git transport) is unreachable from
 * this network while `api.github.com` is not. The commit is rebuilt object by
 * object and every returned SHA is compared against the local one, so the
 * result is the same commit rather than a near-copy: if a blob, tree or commit
 * SHA differed, the script stops before creating the ref.
 *
 * @module dsh-zcode-migrate/scripts/push-via-api
 */

import { execFileSync } from 'node:child_process';

const token = process.env.GITHUB_TOKEN;
if (token === undefined || token === '') throw new Error('GITHUB_TOKEN is not set');
const OWNER = process.argv[2] ?? 'Mr-Grimwig';
const REPO = process.argv[3] ?? 'dsh-zcode-migrate';
const API = 'https://api.github.com';

/** One API call, with the token and a JSON body. */
async function api(method, path, body) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  const parsed = text === '' ? {} : JSON.parse(text);
  if (!response.ok) {
    throw new Error(`${method} ${path} -> ${response.status}: ${JSON.stringify(parsed).slice(0, 400)}`);
  }
  return parsed;
}

/** `git <args>` in this repository. */
function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

const headSha = git('rev-parse', 'HEAD').trim();
const treeSha = git('rev-parse', 'HEAD^{tree}').trim();

/**
 * Parse the raw commit object, so every byte of the rebuilt commit matches —
 * including the message's trailing newline, which `%B` plus a trim would lose
 * and which alone changes the commit hash.
 * @returns {{ author: object, committer: object, message: string }} commit fields for the API.
 */
function commitFields() {
  const raw = execFileSync('git', ['cat-file', 'commit', 'HEAD'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const separator = raw.indexOf('\n\n');
  const headers = raw.slice(0, separator).split('\n');
  const message = raw.slice(separator + 2);

  /** ISO 8601 with the commit's own UTC offset, from "<epoch> <±HHMM>". */
  const isoFromGitDate = (epoch, offset) => {
    const minutes = Number(offset.slice(1, 3)) * 60 + Number(offset.slice(3, 5));
    const sign = offset.startsWith('-') ? -1 : 1;
    const local = new Date((Number(epoch) + sign * minutes * 60) * 1000);
    const pad = (value) => String(value).padStart(2, '0');
    return (
      `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}` +
      `T${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}` +
      `${offset.slice(0, 3)}:${offset.slice(3, 5)}`
    );
  };

  const identity = (line) => {
    const match = /^(.+) <(.+)> (\d+) ([+-]\d{4})$/.exec(line);
    if (match === null) throw new Error(`unparsable identity line: ${line}`);
    return { name: match[1], email: match[2], date: isoFromGitDate(match[3], match[4]) };
  };

  const author = headers.find((line) => line.startsWith('author '));
  const committer = headers.find((line) => line.startsWith('committer '));
  if (author === undefined || committer === undefined) throw new Error('commit object has no author/committer header');
  // Parents travel with the commit: without them the rebuilt commit is a root
  // and its hash cannot match.
  const parents = headers.filter((line) => line.startsWith('parent ')).map((line) => line.slice('parent '.length));
  return {
    author: identity(author.slice('author '.length)),
    committer: identity(committer.slice('committer '.length)),
    message,
    parents,
  };
}

const { author, committer, message, parents } = commitFields();
console.log(`本地提交 ${headSha.slice(0, 12)} tree=${treeSha.slice(0, 12)} parents=${parents.length}`);
console.log(`author=${author.name} <${author.email}> ${author.date}`);

// `-z` matters: without it git quotes non-ASCII paths as octal escapes, and that
// quoted text would be uploaded as a literal file name.
const entries = git('ls-tree', '-r', '-z', 'HEAD')
  .split('\0')
  .filter((line) => line !== '')
  .map((line) => {
    const match = /^(\d+) (\w+) ([0-9a-f]{40})\t([\s\S]*)$/.exec(line);
    if (match === null) throw new Error(`unparsable ls-tree line: ${line}`);
    return { mode: match[1], type: match[2], sha: match[3], path: match[4] };
  });
console.log(`待上传对象 ${entries.length} 个`);

// GitHub refuses the Git Data API on a repository with no commits, so an empty
// one gets a placeholder commit first. It is left unreachable once the branch is
// repointed below, and the final tree is this commit's tree.
const branches = await api('GET', `/repos/${OWNER}/${REPO}/branches`);
if (branches.length === 0) {
  const placeholder = await api('PUT', `/repos/${OWNER}/${REPO}/contents/.gitinit`, {
    message: 'chore: 初始化仓库',
    content: Buffer.from('placeholder\n', 'utf8').toString('base64'),
  });
  console.log(`空仓库，已创建占位提交 ${placeholder.commit.sha.slice(0, 12)}（随后分支会指向真正的提交）`);
}

/** Upload every blob, checking each SHA is reproduced exactly. */
const treeEntries = [];
for (const entry of entries) {
  const content = execFileSync('git', ['cat-file', 'blob', entry.sha], { maxBuffer: 256 * 1024 * 1024 });
  const uploaded = await api('POST', `/repos/${OWNER}/${REPO}/git/blobs`, {
    content: content.toString('base64'),
    encoding: 'base64',
  });
  if (uploaded.sha !== entry.sha) {
    throw new Error(`blob mismatch for ${entry.path}: local ${entry.sha} vs remote ${uploaded.sha}`);
  }
  treeEntries.push({ path: entry.path, mode: entry.mode, type: entry.type, sha: uploaded.sha });
  process.stdout.write('.');
}
console.log('\nblob 全部一致');

const tree = await api('POST', `/repos/${OWNER}/${REPO}/git/trees`, { tree: treeEntries });
if (tree.sha !== treeSha) throw new Error(`tree mismatch: local ${treeSha} vs remote ${tree.sha}`);
console.log(`tree 一致 ${tree.sha.slice(0, 12)}`);

const commit = await api('POST', `/repos/${OWNER}/${REPO}/git/commits`, {
  message,
  tree: tree.sha,
  parents,
  author,
  committer,
});
if (commit.sha !== headSha) {
  throw new Error(`commit mismatch: local ${headSha} vs remote ${commit.sha}`);
}
console.log(`commit 一致 ${commit.sha.slice(0, 12)}`);

// Only now is the ref created: everything above is inert until it points somewhere.
try {
  await api('POST', `/repos/${OWNER}/${REPO}/git/refs`, { ref: 'refs/heads/main', sha: commit.sha });
  console.log('refs/heads/main 已创建');
} catch (error) {
  if (!String(error.message).includes('422')) throw error;
  // Force, because the placeholder commit is not an ancestor of this one.
  await api('PATCH', `/repos/${OWNER}/${REPO}/git/refs/heads/main`, { sha: commit.sha, force: true });
  console.log('refs/heads/main 已指向本次提交');
}

const remoteHead = await api('GET', `/repos/${OWNER}/${REPO}/commits/main`);
console.log(`远端 main = ${remoteHead.sha}  ${remoteHead.commit.message.split('\n')[0]}`);
