import { mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv } from 'ajv';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  acceptWorkflowTask, adjudicateWorkflow, initWorkflow, parseWorkflowReviewFindings, readWorkflow, reviewWorkflow, runWorkflow, verifyWorkflow,
} from '../workflow.js';
import { createWorkflowFixture } from './helpers/workflow-fixture.js';

const provider = fileURLToPath(new URL('./helpers/workflow-provider.cjs', import.meta.url));
const check = { command: process.execPath, args: ['-e', 'process.exit(0)'] };

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, realpathSync: vi.fn(actual.realpathSync) };
});
const originalFs = await vi.importActual<typeof import('node:fs')>('node:fs');
afterEach(() => { vi.mocked(realpathSync).mockImplementation(originalFs.realpathSync); });

const finding = (file: string | null) => ({ findings: [{ severity: 'P2', message: 'Synthetic finding', file, line: 1 }] });

describe('review location boundary for both path dialects', () => {
  it.each([
    ['C:/repo', 'C:/repo/src/a.ts', 'src/a.ts'],
    ['C:\\repo', 'c:\\REPO\\src\\a.ts', 'src/a.ts'],
    ['/repo', '/repo/src/a.ts', 'src/a.ts'],
    ['/repo', 'src/a.ts', 'src/a.ts'],
    ['C:/repo', 'src/a.ts', 'src/a.ts'],
  ])('collects %s location %s as %s', (cwd, file, expected) => {
    // Virtual filesystem identity isolates platform path syntax; real link guards are exercised below.
    vi.mocked(realpathSync).withImplementation(path => path.toString(), () => {
      const raw = finding(file);
      expect(parseWorkflowReviewFindings(raw, 1, cwd)[0].file).toBe(expected);
      expect(raw.findings[0].file).toBe(file);
    });
  });

  it('accepts null without inventing a location', () => {
    expect(parseWorkflowReviewFindings(finding(null), 1, '/repo')[0]).not.toHaveProperty('file');
  });

  it.each([
    ['C:/repo', 'C:/repo'], ['/repo', '/repo'],
    ['C:/repo', 'C:/repo-other/a.ts'], ['/repo', '/repo-other/a.ts'],
    ['C:/repo', 'D:/repo/a.ts'], ['C:/repo', 'C:src/a.ts'],
    ['/repo', '/Repo/a.ts'], ['/repo', '/outside/a.ts'],
    ['C:/repo', 'C:/repo/src/../a.ts'], ['/repo', '/repo/src/../a.ts'],
    ['C:/repo', 'C:/repo/src/./a.ts'], ['/repo', '/repo/src//a.ts'],
    ['C:/repo', '../a.ts'], ['/repo', '../a.ts'],
    ['C:/repo', 'C:/repo/.git/config'], ['/repo', '/repo/.omc/state.json'],
    ['C:/repo', '//server/share/a.ts'], ['C:/repo', '\\\\server\\share\\a.ts'],
    ['C:/repo', '\\\\?\\C:\\repo\\a.ts'], ['/repo', '//repo/a.ts'],
    ['/repo', '/repo/safe\\dir/a.ts'],
    ['C:/repo', 'C:/repo/a.ts:stream'], ['/repo', '/repo/a*.ts'],
  ])('rejects unsafe or ambiguous %s location %s', (cwd, file) => {
    vi.mocked(realpathSync).withImplementation(path => path.toString(), () => {
      expect(() => parseWorkflowReviewFindings(finding(file), 1, cwd)).toThrow('workflow_invalid_scope');
    });
  });

  it.skipIf(process.platform !== 'win32').each(['nul', 'CON.txt', 'a.', 'a '])('retains the Windows reserved-path guard for %s', file => {
    vi.mocked(realpathSync).withImplementation(path => path.toString(), () => {
      expect(() => parseWorkflowReviewFindings(finding(`C:/repo/${file}`), 1, 'C:/repo')).toThrow('workflow_invalid_scope');
    });
  });
});

describe('review finding path collection', () => {
  let fixture: ReturnType<typeof createWorkflowFixture>;
  beforeEach(() => {
    fixture = createWorkflowFixture();
    vi.stubEnv('OMC_WORKFLOW_TEST_CONFIG', fixture.configPath);
    vi.stubEnv('OMC_STATE_DIR', '');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    // Preserve synthetic repositories and artifacts for diagnosis instead of destroying failed evidence.
    console.info(`Synthetic review fixture retained: ${fixture.root}`);
  });

  it('rejects a symlink or junction escape, including a missing leaf', () => {
    const outside = join(fixture.root, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'existing.ts'), 'synthetic');
    symlinkSync(outside, join(fixture.cwd, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    for (const file of ['existing.ts', 'missing.ts']) {
      expect(() => parseWorkflowReviewFindings(finding(join(fixture.cwd, 'escape', file)), 1, fixture.cwd))
        .toThrow('workflow_invalid_scope');
    }
  });

  it('rejects a dangling symlink or junction instead of accepting its parent', () => {
    symlinkSync(join(fixture.root, 'missing-outside'), join(fixture.cwd, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => parseWorkflowReviewFindings(finding(join(fixture.cwd, 'escape', 'missing.ts')), 1, fixture.cwd))
      .toThrow('workflow_invalid_scope');
  });

  async function integrate(codexCommand = provider) {
    await initWorkflow(fixture.cwd, {
      name: 'review-paths', objective: 'Validate review collection', baseCommit: fixture.baseCommit,
      integrationBranch: 'integration/review-paths', verification: [check], tasks: [{
        id: 'a', objective: 'Implement synthetic component', baseCommit: fixture.baseCommit,
        writeScope: ['feature/a.txt'], readScope: ['README.md'], prohibitedScope: [], dependencies: [],
        contracts: ['Preserve the fixture API.'], acceptanceCriteria: ['The component exists.'], tests: [check],
      }],
    }, { mode: 'balanced', glmCommand: provider, codexCommand, maxAttempts: 1 });
    await runWorkflow(fixture.cwd, 'review-paths');
    await acceptWorkflowTask(fixture.cwd, 'review-paths', 'a');
    await verifyWorkflow(fixture.cwd, 'review-paths');
  }

  it('collects findings through a provider that rejects regex lookarounds at schema admission', async () => {
    const schemaProvider = join(fixture.root, 'schema-admission-provider.cjs');
    // Model the observed provider restriction, not an entire provider regex implementation.
    writeFileSync(schemaProvider, `
      const { readFileSync } = require('node:fs');
      const schema = JSON.parse(readFileSync(process.argv[process.argv.indexOf('--output-schema') + 1], 'utf8'));
      const pattern = schema.properties.findings.items.properties.file.pattern;
      if (['(?=', '(?!', '(?<=', '(?<!'].some(operator => pattern.includes(operator))) {
        process.stderr.write('Synthetic HTTP 400 invalid_json_schema: regex lookaround is not supported.');
        process.exit(1);
      }
      require(${JSON.stringify(provider)});
    `);
    fixture.configure(finding('feature/a.txt'));
    await integrate(schemaProvider);
    const reviewed = await reviewWorkflow(fixture.cwd, 'review-paths');
    expect(reviewed.reviews[0].findings).toEqual([
      { id: 'review-1-1', severity: 'P2', message: 'Synthetic finding', file: 'feature/a.txt', line: 1 },
    ]);
    expect(reviewed.reviewAttempts?.[0].outcome).toBe('completed');
  });

  it.each(['absolute', 'relative'])('collects six %s findings, preserves raw metadata and permits lead adjudication', async style => {
    const files = ['feature/a.txt', 'README.md', 'docs/audit.md', 'docs/audit.md', 'docs/audit.md', 'docs/audit.md'];
    const findings = files.map((file, index) => ({
      severity: index < 4 ? 'P2' : 'P3', message: `Synthetic finding ${index + 1}`,
      file: style === 'absolute' ? join(fixture.cwd, file).replaceAll('\\', '/') : file, line: index + 1,
    }));
    fixture.configure({ findings });
    await integrate();
    const reviewed = await reviewWorkflow(fixture.cwd, 'review-paths');
    expect(reviewed.reviews[0].findings.map(finding => finding.file)).toEqual(files);
    expect(reviewed.reviewAttempts?.[0].outcome).toBe('completed');
    const artifact = join(fixture.cwd, '.omc/state/team/review-paths/artifacts/review-1.result.json');
    expect(JSON.parse(readFileSync(artifact, 'utf8'))).toEqual({ findings });
    const request = JSON.parse(fixture.events().find(event => event.role === 'codex')!.prompt);
    expect(request.instructions).toContain('repository-relative POSIX path or null');
    const schema = JSON.parse(readFileSync(artifact.replace('.result.json', '.schema.json'), 'utf8'));
    expect(schema.properties.findings.items.properties.file.pattern).not.toContain('(?');
    expect(schema.properties.findings.items.properties.file.pattern).not.toMatch(/\\(?:[1-9]|k[<'])/);
    const validate = new Ajv().compile(schema);
    for (const file of [...files.map(file => `C:/synthetic-repo/${file}`), '/repo/a.ts', '//server/share/a.ts',
      '\\\\server\\share\\a.ts', 'C:src/a.ts', 'src\\a.ts', '', 'src//a.ts']) {
      expect(validate(finding(file)), `Schema must reject ${file}`).toBe(false);
    }
    // These semantic scope restrictions stay authoritative in the local parser, not provider regex features.
    for (const file of ['../a.ts', 'src/../a.ts', './a.ts', '.git/config', '.omc/state.json']) {
      expect(validate(finding(file)), `The coarse schema delegates ${file} to the local scope guard`).toBe(true);
      expect(() => parseWorkflowReviewFindings(finding(file), 1, fixture.cwd)).toThrow('workflow_invalid_scope');
    }
    expect(validate(finding('src/example.ts'))).toBe(true);
    expect(validate(finding(null))).toBe(true);
    expect(request.instructions).toContain('src/example.ts');
    const adjudicated = await adjudicateWorkflow(fixture.cwd, 'review-paths', reviewed.reviews[0].findings.map(finding => ({
      findingId: finding.id, disposition: 'dismiss' as const, reason: 'Synthetic collection test only.',
    })));
    expect(adjudicated.reviews[0].findings.every(finding => finding.disposition === 'dismiss')).toBe(true);
    expect(adjudicated.reviewPasses).toBe(1);
  });

  it.each([
    ['outside path', { file: '/outside/a.ts' }, 'workflow_invalid_scope'],
    ['foreign drive', { file: 'Z:/outside/a.ts' }, 'workflow_invalid_scope'],
    ['traversal', { file: '../a.ts' }, 'workflow_invalid_scope'],
    ['reserved Git scope', { file: '.git/config' }, 'workflow_invalid_scope'],
    ['reserved workflow scope', { file: '.omc/state.json' }, 'workflow_invalid_scope'],
    ['malformed severity', { severity: 'INVALID' }, 'workflow_invalid_severity'],
  ])('preserves the failed attempt and result for %s', async (_label, override, error) => {
    const findings = [{ ...finding('feature/a.txt').findings[0], ...override }];
    fixture.configure({ findings });
    await integrate();
    await expect(reviewWorkflow(fixture.cwd, 'review-paths')).rejects.toThrow(error);
    const state = readWorkflow(fixture.cwd, 'review-paths');
    expect(state.reviews).toEqual([]);
    expect(state.reviewPasses).toBe(1);
    expect(state.reviewAttempts?.[0]).toMatchObject({ outcome: 'failed', error });
    expect(JSON.parse(readFileSync(join(fixture.cwd, '.omc/state/team/review-paths/artifacts/review-1.result.json'), 'utf8')))
      .toEqual({ findings });
  });
});
