import { constants, closeSync, fchmodSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, readSync, realpathSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const VERSION = '0.27.2';
const SQLITE_VERSION = '12.11.1';
const refuse = () => { throw new Error('ci_esbuild_custody_refused'); };
const same = (a, b) => ['dev', 'ino', 'nlink', 'size', 'mode', 'mtimeMs', 'ctimeMs'].every(key => a[key] === b[key]);
const identity = (a, b) => a.dev === b.dev && a.ino === b.ino;
function directory(path) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory() || realpathSync(path) !== resolve(path)) refuse();
}
function regular(path, links) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile() || !links.includes(stat.nlink) || realpathSync(path) !== resolve(path)) refuse();
  return stat;
}
function digest(path, expected) {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!same(fstatSync(fd), expected)) refuse();
    const hash = createHash('sha256'), chunk = Buffer.alloc(65536);
    for (;;) { const count = readSync(fd, chunk, 0, chunk.length, null); if (!count) break; hash.update(chunk.subarray(0, count)); }
    if (!same(fstatSync(fd), expected) || !same(lstatSync(path), expected)) refuse();
    return hash.digest('hex');
  } finally { closeSync(fd); }
}
function manifest(path) {
  const before = regular(path, [1]); const bytes = readFileSync(path);
  if (!same(lstatSync(path), before)) refuse();
  return JSON.parse(bytes.toString('utf8'));
}

function detachPair(workspace, paths) {
  const target = join(workspace, paths[0]), source = join(workspace, paths[1]);
  const before = [regular(target, [1, 2]), regular(source, [1, 2])];
  const hashes = [digest(target, before[0]), digest(source, before[1])];
  const linked = identity(before[0], before[1]);
  if (hashes[0] !== hashes[1] || before[0].mode !== before[1].mode
    || (linked ? before.some(stat => stat.nlink !== 2) : before.some(stat => stat.nlink !== 1))) refuse();
  let outcome = 'already-detached';
  if (linked) {
    const temporary = join(dirname(target), `.esbuild-custody-${randomUUID()}`);
    let temporaryIdentity, output, input;
    try {
      output = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
      temporaryIdentity = fstatSync(output);
      input = openSync(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      if (!same(fstatSync(input), before[1])) refuse();
      const chunk = Buffer.alloc(65536);
      for (;;) {
        const count = readSync(input, chunk, 0, chunk.length, null); if (!count) break;
        for (let offset = 0; offset < count;) { const written = writeSync(output, chunk, offset, count - offset); if (!written) refuse(); offset += written; }
      }
      fchmodSync(output, before[0].mode & 0o7777); fsyncSync(output);
      if (!same(fstatSync(input), before[1])) refuse();
      closeSync(input); input = undefined; closeSync(output); output = undefined;
      const copied = regular(temporary, [1]);
      if (!identity(copied, temporaryIdentity) || copied.mode !== before[0].mode || digest(temporary, copied) !== hashes[0]) refuse();
      // Revalidate both known endpoints immediately before replacing this one owned alias.
      if (!same(regular(target, [2]), before[0]) || !same(regular(source, [2]), before[1])) refuse();
      renameSync(temporary, target); temporaryIdentity = undefined; outcome = 'detached';
    } finally {
      if (input !== undefined) closeSync(input);
      if (output !== undefined) closeSync(output);
      if (temporaryIdentity) {
        const remaining = lstatSync(temporary);
        if (remaining.isFile() && remaining.nlink === 1 && identity(remaining, temporaryIdentity)) unlinkSync(temporary);
      }
    }
  }
  const after = [regular(target, [1]), regular(source, [1])];
  if (identity(after[0], after[1])) refuse();
  for (let index = 0; index < 2; index++) {
    if ((!linked && !same(after[index], before[index])) || after[index].mode !== before[index].mode
      || digest(join(workspace, paths[index]), after[index]) !== hashes[index]) refuse();
  }
  if (!same(lstatSync(target), after[0]) || !same(lstatSync(source), after[1])) refuse();
  return { outcome, files: paths.map((path, index) => ({ path, beforeLinks: before[index].nlink,
    afterLinks: after[index].nlink, sha256: hashes[index], mode: after[index].mode & 0o7777 })) };
}

/** Only the pinned install-time aliases in a private hosted npm-ci workspace. */
export function prepareCiEsbuildCustody() {
  const workspace = resolve(process.cwd());
  if (process.env.CI !== 'true' || process.env.GITHUB_ACTIONS !== 'true'
    || process.env.RUNNER_ENVIRONMENT !== 'github-hosted'
    || process.env.GITHUB_WORKSPACE !== workspace) refuse();
  directory(workspace); directory(join(workspace, '.git')); directory(join(workspace, 'node_modules'));
  const lock = manifest(join(workspace, 'package-lock.json'));
  const esbuild = join(workspace, 'node_modules', 'esbuild'); directory(esbuild); directory(join(esbuild, 'bin'));
  const installed = manifest(join(esbuild, 'package.json'));
  if (installed.name !== 'esbuild' || installed.version !== VERSION || lock.packages?.['node_modules/esbuild']?.version !== VERSION) refuse();
  // The workflow invokes this only on its Unix hosts. Windows installations have no such alias.
  const platform = `${process.platform}-${process.arch}`;
  if (!['linux-x64', 'darwin-arm64', 'darwin-x64'].includes(platform)) refuse();
  const packageName = `@esbuild/${platform}`, packagePath = `node_modules/${packageName}`;
  directory(join(workspace, 'node_modules', '@esbuild'));
  const binaryRoot = join(workspace, packagePath); directory(binaryRoot); directory(join(binaryRoot, 'bin'));
  const binaryManifest = manifest(join(binaryRoot, 'package.json'));
  if (binaryManifest.name !== packageName || binaryManifest.version !== VERSION
    || installed.optionalDependencies?.[packageName] !== VERSION || lock.packages?.[packagePath]?.version !== VERSION) refuse();
  let native;
  if (platform === 'linux-x64' && process.versions.node.startsWith('20.')) {
    const packagePath = 'node_modules/better-sqlite3', packageRoot = join(workspace, packagePath);
    directory(packageRoot);
    const installed = manifest(join(packageRoot, 'package.json'));
    if (installed.name !== 'better-sqlite3' || installed.version !== SQLITE_VERSION
      || lock.packages?.[packagePath]?.version !== SQLITE_VERSION) refuse();
    const release = `${packagePath}/build/Release`, objects = `${release}/obj.target`;
    directory(join(packageRoot, 'build')); directory(join(workspace, release));
    let built = true;
    try { directory(join(workspace, objects)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; built = false; }
    if (built) {
      directory(join(workspace, objects, 'deps'));
      const pairs = [['better_sqlite3.node', 'better_sqlite3.node'], ['test_extension.node', 'test_extension.node'], ['sqlite3.a', 'deps/sqlite3.a']]
        .map(([target, source]) => detachPair(workspace, [`${release}/${target}`, `${objects}/${source}`]));
      native = { outcome: pairs.some(pair => pair.outcome === 'detached') ? 'detached' : 'already-detached',
        version: SQLITE_VERSION, files: pairs.flatMap(pair => pair.files) };
    } else {
      const path = `${release}/better_sqlite3.node`, before = regular(join(workspace, path), [1]);
      native = { outcome: 'single-link-installation', version: SQLITE_VERSION, files: [{ path, beforeLinks: 1, afterLinks: 1,
        sha256: digest(join(workspace, path), before), mode: before.mode & 0o7777 }] };
    }
  }
  return { ...detachPair(workspace, ['node_modules/esbuild/bin/esbuild', `${packagePath}/bin/esbuild`]),
    version: VERSION, ...(native ? { native } : {}) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(`${JSON.stringify(prepareCiEsbuildCustody())}\n`); }
  catch { process.stderr.write('{"outcome":"refused","code":"ci_esbuild_custody_refused"}\n'); process.exitCode = 1; }
}
