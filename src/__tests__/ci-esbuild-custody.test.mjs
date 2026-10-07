import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { Buffer } from 'node:buffer';
import * as fs from 'node:fs';
import { prepareCiEsbuildCustody } from '../../scripts/prepare-ci-esbuild-custody.mjs';

vi.mock('node:fs', async importOriginal => ({ ...await importOriginal() }));

const roots = [];
const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
const archDescriptor = Object.getOwnPropertyDescriptor(process, 'arch');
const nodeDescriptor = Object.getOwnPropertyDescriptor(process.versions, 'node');
const originalPlatform = process.platform;
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); Object.defineProperty(process, 'platform', platformDescriptor); Object.defineProperty(process, 'arch', archDescriptor); Object.defineProperty(process.versions, 'node', nodeDescriptor); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(platform = 'linux', arch = 'x64') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ci-esbuild-custody-'))); roots.push(root);
  const packageName = `@esbuild/${platform}-${arch}`;
  const targetRoot = join(root, 'node_modules/esbuild'), sourceRoot = join(root, `node_modules/${packageName}`);
  mkdirSync(join(root, '.git')); mkdirSync(join(targetRoot, 'bin'), { recursive: true }); mkdirSync(join(sourceRoot, 'bin'), { recursive: true });
  const target = join(targetRoot, 'bin/esbuild'), source = join(sourceRoot, 'bin/esbuild');
  writeFileSync(source, Buffer.alloc(131077, 0x6a)); chmodSync(source, 0o755); linkSync(source, target);
  const nativeRoot = join(root, 'node_modules/better-sqlite3'), nativeBinary = join(nativeRoot, 'build/Release/better_sqlite3.node');
  mkdirSync(join(nativeRoot, 'build/Release'), { recursive: true }); writeFileSync(nativeBinary, 'installed native binary');
  writeFileSync(join(nativeRoot, 'package.json'), JSON.stringify({ name: 'better-sqlite3', version: '12.11.1' }));
  writeFileSync(join(root, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/esbuild': { version: '0.27.2' }, [`node_modules/${packageName}`]: { version: '0.27.2' }, 'node_modules/better-sqlite3': { version: '12.11.1' } } }));
  writeFileSync(join(targetRoot, 'package.json'), JSON.stringify({ name: 'esbuild', version: '0.27.2', optionalDependencies: { [packageName]: '0.27.2' } }));
  writeFileSync(join(sourceRoot, 'package.json'), JSON.stringify({ name: packageName, version: '0.27.2' }));
  for (const [key, value] of Object.entries({ CI: 'true', GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', GITHUB_WORKSPACE: root })) vi.stubEnv(key, value);
  vi.spyOn(process, 'cwd').mockReturnValue(root); Object.defineProperty(process, 'platform', { ...platformDescriptor, value: platform });
  Object.defineProperty(process, 'arch', { ...archDescriptor, value: arch });
  Object.defineProperty(process.versions, 'node', { ...nodeDescriptor, value: '20.20.2' });
  return { root, targetRoot, sourceRoot, target, source, nativeRoot, nativeBinary };
}
function nativeFixture() {
  const f = fixture(), release = join(f.nativeRoot, 'build/Release'), objects = join(release, 'obj.target');
  mkdirSync(join(objects, 'deps'), { recursive: true }); unlinkSync(f.nativeBinary);
  const pairs = [['better_sqlite3.node', 'better_sqlite3.node'], ['test_extension.node', 'test_extension.node'], ['sqlite3.a', 'deps/sqlite3.a']]
    .map(([name, source], index) => {
      const pair = [join(release, name), join(objects, source)];
      writeFileSync(pair[1], Buffer.alloc(131077 + index, 0x61 + index)); chmodSync(pair[1], 0o755); linkSync(pair[1], pair[0]);
      return pair;
    });
  return { ...f, objects, pairs };
}
const refused = () => expect(() => prepareCiEsbuildCustody()).toThrow('ci_esbuild_custody_refused');

describe('private hosted esbuild installation custody', () => {
  it.each([['linux', 'x64'], ['darwin', 'arm64'], ['darwin', 'x64']])('detaches the known %s %s pair, preserves bytes and modes, and validates without rewriting', (platform, arch) => {
    const f = fixture(platform, arch), bytes = readFileSync(f.source), mode = lstatSync(f.source).mode;
    const result = prepareCiEsbuildCustody(); expect(result.outcome).toBe('detached');
    expect(result.files.map(file => [file.beforeLinks, file.afterLinks])).toEqual([[2, 1], [2, 1]]);
    for (const path of [f.target, f.source]) { expect(readFileSync(path)).toEqual(bytes); expect(lstatSync(path).mode).toBe(mode); }
    expect(lstatSync(f.target).ino).not.toBe(lstatSync(f.source).ino);
    const before = lstatSync(f.target); expect(prepareCiEsbuildCustody().outcome).toBe('already-detached');
    const after = lstatSync(f.target);
    for (const key of ['dev', 'ino', 'nlink', 'size', 'mode', 'mtimeMs', 'ctimeMs']) expect(after[key]).toBe(before[key]);
    expect(readdirSync(join(f.targetRoot, 'bin'))).toEqual(['esbuild']);
  });
  it.each(['CI', 'GITHUB_ACTIONS', 'RUNNER_ENVIRONMENT', 'GITHUB_WORKSPACE'])('refuses missing ownership %s before touching binaries', key => {
    const f = fixture(); vi.stubEnv(key, ''); refused(); expect(lstatSync(f.target).nlink).toBe(2);
  });
  it('refuses a shared node_modules alias', () => {
    const f = fixture(), shared = realpathSync(mkdtempSync(join(tmpdir(), 'ci-esbuild-shared-'))); roots.push(shared);
    rmSync(join(f.root, 'node_modules'), { recursive: true }); symlinkSync(shared, join(f.root, 'node_modules'), originalPlatform === 'win32' ? 'junction' : 'dir');
    refused(); expect(readdirSync(shared)).toEqual([]);
  });
  it('refuses a linked package root within the workspace', () => {
    const f = fixture(); rmSync(f.targetRoot, { recursive: true }); symlinkSync(f.sourceRoot, f.targetRoot, originalPlatform === 'win32' ? 'junction' : 'dir'); refused();
  });
  it.each(['installed', 'lock', 'platform'])('refuses an unexpected pinned %s version', kind => {
    const f = fixture(), path = kind === 'installed' ? join(f.targetRoot, 'package.json') : kind === 'platform' ? join(f.sourceRoot, 'package.json') : join(f.root, 'package-lock.json');
    writeFileSync(path, readFileSync(path, 'utf8').replaceAll('0.27.2', '0.27.3')); refused(); expect(lstatSync(f.target).nlink).toBe(2);
  });
  it('refuses a third link instead of repairing an arbitrary alias set', () => {
    const f = fixture(); linkSync(f.source, join(f.root, 'unexpected')); refused(); expect(lstatSync(f.target).nlink).toBe(3);
  });
  it('refuses independent endpoints with differing bytes', () => {
    const f = fixture(); unlinkSync(f.target); writeFileSync(f.target, 'different'); chmodSync(f.target, lstatSync(f.source).mode & 0o7777); refused();
  });
  it('refuses independent endpoints with differing modes', () => {
    const f = fixture(); unlinkSync(f.target); writeFileSync(f.target, readFileSync(f.source)); chmodSync(f.target, 0o444); refused(); chmodSync(f.target, 0o666);
  });
  it('refuses a linked manifest before creating a temporary file', () => {
    const f = fixture(); linkSync(join(f.targetRoot, 'package.json'), join(f.root, 'manifest-alias')); refused(); expect(readdirSync(join(f.targetRoot, 'bin'))).toEqual(['esbuild']);
  });
  it('refuses source mutation during copying and removes only its owned temporary file', () => {
    const f = fixture(), write = fs.writeSync; let changed = false;
    vi.spyOn(fs, 'writeSync').mockImplementation((...args) => {
      const count = write(...args);
      if (!changed) { changed = true; writeFileSync(f.source, 'changed during copy'); }
      return count;
    });
    refused(); expect(lstatSync(f.target).nlink).toBe(2); expect(readdirSync(join(f.targetRoot, 'bin'))).toEqual(['esbuild']);
  });
  it('refuses unsupported platforms without changing the pair', () => {
    const f = fixture(); Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'win32' }); refused(); expect(lstatSync(f.target).nlink).toBe(2);
  });
});

describe('private hosted Node 20 Linux native installation custody', () => {
  it('detaches only the three proved COPY pairs with unchanged bytes and modes and validates without rewriting', () => {
    const f = nativeFixture(), before = f.pairs.map(([target]) => ({ bytes: readFileSync(target), mode: lstatSync(target).mode }));
    const result = prepareCiEsbuildCustody(); expect(result.native.outcome).toBe('detached');
    expect(result.native.version).toBe('12.11.1');
    expect(result.native.files.map(file => [file.beforeLinks, file.afterLinks])).toEqual(Array.from({ length: 6 }, () => [2, 1]));
    for (const [index, pair] of f.pairs.entries()) {
      for (const path of pair) { expect(readFileSync(path)).toEqual(before[index].bytes); expect(lstatSync(path).mode).toBe(before[index].mode); expect(lstatSync(path).nlink).toBe(1); }
      expect(lstatSync(pair[0]).ino).not.toBe(lstatSync(pair[1]).ino);
    }
    const detached = f.pairs.flat().map(path => lstatSync(path));
    expect(prepareCiEsbuildCustody().native.outcome).toBe('already-detached');
    for (const [index, path] of f.pairs.flat().entries()) {
      const after = lstatSync(path);
      for (const key of ['dev', 'ino', 'nlink', 'size', 'mode', 'mtimeMs', 'ctimeMs']) expect(after[key]).toBe(detached[index][key]);
    }
  });
  it('accepts an installed single-link binary without an obj.target directory and leaves it unchanged', () => {
    const f = fixture(), before = lstatSync(f.nativeBinary), bytes = readFileSync(f.nativeBinary);
    const result = prepareCiEsbuildCustody(); expect(result.native.outcome).toBe('single-link-installation');
    expect(result.native.files.map(file => [file.beforeLinks, file.afterLinks])).toEqual([[1, 1]]);
    const after = lstatSync(f.nativeBinary);
    for (const key of ['dev', 'ino', 'nlink', 'size', 'mode', 'mtimeMs', 'ctimeMs']) expect(after[key]).toBe(before[key]);
    expect(readFileSync(f.nativeBinary)).toEqual(bytes);
  });
  it.each(['installed', 'lock'])('refuses an unexpected native %s pin before changing aliases', kind => {
    const f = nativeFixture(), path = kind === 'installed' ? join(f.nativeRoot, 'package.json') : join(f.root, 'package-lock.json');
    writeFileSync(path, readFileSync(path, 'utf8').replaceAll('12.11.1', '12.11.2')); refused();
    for (const pair of f.pairs) for (const path of pair) expect(lstatSync(path).nlink).toBe(2);
  });
  it('refuses an unexpected third native link before changing aliases', () => {
    const f = nativeFixture(); linkSync(f.pairs[0][1], join(f.root, 'unexpected')); refused();
    expect(lstatSync(f.pairs[0][0]).nlink).toBe(3);
    for (const pair of f.pairs.slice(1)) for (const path of pair) expect(lstatSync(path).nlink).toBe(2);
  });
  it('refuses a redirected native obj.target directory instead of treating it as absent', () => {
    const f = fixture(), actual = join(f.root, 'objects'); mkdirSync(actual);
    symlinkSync(actual, join(f.nativeRoot, 'build/Release/obj.target'), originalPlatform === 'win32' ? 'junction' : 'dir'); refused();
    expect(lstatSync(f.nativeBinary).nlink).toBe(1); expect(lstatSync(f.target).nlink).toBe(2);
  });
});
