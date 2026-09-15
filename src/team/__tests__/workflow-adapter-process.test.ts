import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runWorkflowProcess } from '../workflow-process.js';
import { createClaudeWorkflowResultDecoder } from '../workflow-adapters.js';

afterEach(() => vi.unstubAllEnvs());
describe('explicit private process boundary', () => {
  it('redacts JSON-escaped private values before stdout artifacts are written', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omc-v2-escaped-'));
    const sentinel = 'synthetic-quoted-"-backslash-\\-newline-\n-private';
    const result = await runWorkflowProcess({ command: process.execPath, args: ['-e', `process.stdout.write(JSON.stringify({summary:${JSON.stringify(sentinel)}}))`],
      cwd, timeoutMs: 5000, artifactPrefix: join(cwd, 'escaped'), environment: {}, redactionEnvironment: { PRIVATE_FILE_SECRET: sentinel } });
    expect(result.passed).toBe(true);
    expect(JSON.parse(readFileSync(result.artifacts[0].path, 'utf8')).summary).toBe('[REDACTED]');
  });
  it('keeps redaction-only secrets out of children and redacts split and truncated output', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omc-v2-private-'));
    const sentinel = 'only-controller-knows-this-synthetic-value';
    const code = `process.stdout.write(JSON.stringify({ inherited: !!process.env.CONTROLLER_SECRET })); process.stderr.write(${JSON.stringify(sentinel)}.slice(0,12)); setTimeout(() => process.stderr.write(${JSON.stringify(sentinel)}.slice(12)), 10)`;
    const result = await runWorkflowProcess({ command: process.execPath, args: ['-e', code], cwd, timeoutMs: 5000,
      artifactPrefix: join(cwd, 'split'), environment: {}, redactionEnvironment: { CONTROLLER_SECRET: sentinel } });
    expect(result.passed).toBe(true);
    expect(JSON.parse(readFileSync(result.artifacts[0].path, 'utf8')).inherited).toBe(false);
    expect(readFileSync(result.artifacts[1].path, 'utf8')).toBe('[REDACTED]');
    const truncated = await runWorkflowProcess({ command: process.execPath, args: ['-e', `process.stdout.write('x'.repeat(1024*1024-18)+${JSON.stringify(sentinel)})`],
      cwd, timeoutMs: 5000, artifactPrefix: join(cwd, 'truncated'), environment: {}, redactionEnvironment: { CONTROLLER_SECRET: sentinel } });
    expect(readFileSync(truncated.artifacts[0].path, 'utf8')).not.toContain('only-controller');
  });

  it('preserves interrupted terminal evidence without restarting a child', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omc-v2-interrupted-'));
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const running = runWorkflowProcess({ command: process.execPath, args: ['-e', 'process.stdout.write("ready"); setTimeout(()=>{},30000)'],
      cwd, timeoutMs: 5000, artifactPrefix: join(cwd, 'interrupted'), environment: {}, onStdout: started });
    await ready;
    process.emit('SIGTERM');
    const result = await running;
    expect(result).toMatchObject({ passed: false, error: 'interrupted' });
    expect(readFileSync(result.artifacts[0].path, 'utf8')).toBe('ready');
  });
});

describe('Claude terminal protocol bounds', () => {
  it('contains deep structured-output serialization failure inside the decoder', () => {
    const decoder = createClaudeWorkflowResultDecoder();
    const raw = '{"type":"result","subtype":"success","is_error":false,"structured_output":' + '['.repeat(12000) + '0' + ']'.repeat(12000) + '}\n';
    expect(() => decoder.write(Buffer.from(raw))).not.toThrow();
    expect(() => decoder.finish()).toThrow('workflow_invalid_claude_result');
  });
  it.each(['missing', 'malformed', 'duplicate', 'oversized', 'failure'])('rejects %s terminal evidence', defect => {
    const decoder = createClaudeWorkflowResultDecoder();
    const event = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, structured_output: { findings: [] } }) + '\n';
    const raw = defect === 'missing' ? '{"type":"system"}\n' : defect === 'malformed' ? 'not json\n'
      : defect === 'duplicate' ? event + event : defect === 'oversized' ? 'x'.repeat(256 * 1024 + 1)
        : '{"type":"result","subtype":"error_during_execution","is_error":true}\n';
    decoder.write(Buffer.from(raw));
    expect(() => decoder.finish()).toThrow('workflow_invalid_claude_result');
  });
  it('accepts one structured terminal across UTF-8 chunks without using transcript text as a result', () => {
    const decoder = createClaudeWorkflowResultDecoder();
    const output = { findings: [{ severity: 'P2', message: 'Unicode café example', file: null, line: null }] };
    const bytes = Buffer.from(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, structured_output: output }) + '\n');
    for (const byte of bytes) decoder.write(Buffer.from([byte]));
    expect(decoder.finish()).toEqual(output);
  });
});
