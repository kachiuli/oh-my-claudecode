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
const originalPlatform = process.platform;
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); Object.defineProperty(process, 'platform', platformDescriptor); Object.defineProperty(process, 'arch', archDescriptor); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(platform = 'linux', arch = 'x64') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ci-esbuild-custody-'))); roots.push(root);
  const packageName = `@esbuild/${platform}-${arch}`;
  const targetRoot = join(root, 'node_modules/esbuild'), sourceRoot = join(root, `node_modules/${packageName}`);
  mkdirSync(join(root, '.git')); mkdirSync(join(targetRoot, 'bin'), { recursive: true }); mkdirSync(join(sourceRoot, 'bin'), { recursive: true });
  const target = join(targetRoot, 'bin/esbuild'), source = join(sourceRoot, 'bin/esbuild');
  writeFileSync(source, Buffer.alloc(131077, 0x6a)); chmodSync(source, 0o755); linkSync(source, target);
  writeFileSync(join(root, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/esbuild': { version: '0.27.2' }, [`node_modules/${packageName}`]: { version: '0.27.2' } } }));
  writeFileSync(join(targetRoot, 'package.json'), JSON.stringify({ name: 'esbuild', version: '0.27.2', optionalDependencies: { [packageName]: '0.27.2' } }));
  writeFileSync(join(sourceRoot, 'package.json'), JSON.stringify({ name: packageName, version: '0.27.2' }));
  for (const [key, value] of Object.entries({ CI: 'true', GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', GITHUB_WORKSPACE: root })) vi.stubEnv(key, value);
  vi.spyOn(process, 'cwd').mockReturnValue(root); Object.defineProperty(process, 'platform', { ...platformDescriptor, value: platform });
  Object.defineProperty(process, 'arch', { ...archDescriptor, value: arch });
  return { root, targetRoot, sourceRoot, target, source };
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
