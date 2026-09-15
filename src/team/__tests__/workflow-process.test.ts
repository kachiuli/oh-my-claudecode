import { linkSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runWorkflowProcess } from '../workflow-process.js';

describe('bounded one-shot workflow process', () => {
  let cwd: string;
  beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), 'omc-workflow-process-')); });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(cwd, { recursive: true, force: true });
  });
  function run(code: string, args: string[] = [], timeoutMs = 5000) {
    return runWorkflowProcess({ command: process.execPath, args: ['-e', code, '--', ...args], cwd,
      timeoutMs, artifactPrefix: join(cwd, 'worker') });
  }

  it('passes shell metacharacters as literal arguments to the executable', async () => {
    const untrusted = '$(touch owned); echo "unsafe" & | > < %PATH%';
    const result = await run('process.stdout.write(JSON.stringify(process.argv.slice(1)))', [untrusted]);
    expect(result.passed).toBe(true);
    expect(JSON.parse(readFileSync(result.artifacts[0]!.path, 'utf8'))).toEqual([untrusted]);
  });

  it('stores large output only in size-bounded artifact files', async () => {
    const result = await run('process.stdout.write("PRIVATE_TRANSCRIPT".repeat(15000)); process.stderr.write("PRIVATE_ERROR".repeat(15000))');
    expect(result.passed).toBe(true);
    expect(JSON.stringify(result)).not.toContain('PRIVATE_TRANSCRIPT');
    expect(JSON.stringify(result)).not.toContain('PRIVATE_ERROR');
    expect(JSON.stringify(result).length).toBeLessThan(2500);
    expect(readFileSync(result.artifacts[0]!.path).length).toBeGreaterThan(100000);
    for (const artifact of result.artifacts) expect(artifact.sizeBytes).toBeLessThanOrEqual(1024 * 1024);
  });

  it('bounds artifact output when a child exceeds the capture limit', async () => {
    const result = await run('process.stdout.write("OVERSIZED_TRANSCRIPT".repeat(150000))');
    expect(result.passed).toBe(true);
    expect(JSON.stringify(result)).not.toContain('OVERSIZED_TRANSCRIPT');
    const output = readFileSync(result.artifacts[0]!.path, 'utf8');
    expect(output.length).toBeGreaterThan(100000);
    expect(result.artifacts[0]!.sizeBytes).toBeLessThanOrEqual(1024 * 1024);
  });

  it('redacts credentials split across stdout chunks before persisting artifacts', async () => {
    vi.stubEnv('OMC_FIXTURE_API_TOKEN', 'fixture-sensitive-secret-12345');
    const result = await run('const s=process.env.OMC_FIXTURE_API_TOKEN; process.stdout.write(s.slice(0,12)); setTimeout(()=>process.stdout.write(s.slice(12)),20);');
    expect(result.passed).toBe(true);
    expect(readFileSync(result.artifacts[0]!.path, 'utf8')).toBe('[REDACTED]');
    expect(JSON.stringify(result)).not.toContain('fixture-sensitive');
  });

  it('does not persist a partial credential at the output capture boundary', async () => {
    vi.stubEnv('OMC_FIXTURE_API_TOKEN', 'boundarySensitiveCredential-1234567890');
    const result = await run('process.stdout.write("x".repeat(1024*1024-20)+process.env.OMC_FIXTURE_API_TOKEN)');
    expect(result.passed).toBe(true);
    const output = readFileSync(result.artifacts[0]!.path, 'utf8');
    expect(output).not.toContain('boundarySensitive');
    expect(output.length).toBeGreaterThan(100000);
  });

  it('ends an unresponsive child at the configured timeout', async () => {
    const result = await run('setInterval(()=>{},1000)', [], 100);
    expect(result.passed).toBe(false);
    expect(result.error).toBe('timeout');
  });

  it('reports a missing executable without exposing the attempted command output', async () => {
    const result = await runWorkflowProcess({ command: join(cwd, 'unavailable-provider'), args: [], cwd,
      timeoutMs: 1000, artifactPrefix: join(cwd, 'missing') });
    expect(result.passed).toBe(false);
    expect(result.error).toBe('launch_failed');
    expect(result.artifacts).toHaveLength(2);
  });

  it.each(['HTTP 429', 'rate_limit_exceeded', 'Too many requests'])(
    'classifies an unsuccessful provider response containing %s as throttled', async message => {
      const result = await run('process.stderr.write(process.argv[1]); process.exitCode=1', [message]);
      expect(result.passed).toBe(false);
      expect(result.error).toBe('throttled');
      expect(JSON.stringify(result)).not.toContain(message);
    },
  );

  it('does not classify successful output mentioning rate limits as failure', async () => {
    const result = await run('process.stdout.write("HTTP 429 handling verified")');
    expect(result.passed).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('keeps ordinary process failures distinct from provider throttling', async () => {
    const result = await run('process.stderr.write("Invalid input"); process.exitCode=2');
    expect(result.passed).toBe(false);
    expect(result.error).toBe('process_failed');
  });

  it('refuses to overwrite a preexisting regular artifact', async () => {
    const output = join(cwd, 'worker.stdout.log');
    writeFileSync(output, 'existing user content');
    await expect(run('process.stdout.write("replacement")')).rejects.toThrow('workflow_artifact_write_refused');
    expect(readFileSync(output, 'utf8')).toBe('existing user content');
  });

  it('refuses an artifact hardlink created by the worker and preserves its target', async () => {
    const target = join(cwd, 'protected.txt');
    const output = join(cwd, 'worker.stdout.log');
    writeFileSync(target, 'protected user content');
    await expect(run('require("node:fs").linkSync(process.argv[1], process.argv[2]); process.stdout.write("replacement")', [target, output]))
      .rejects.toThrow('workflow_artifact_write_refused');
    expect(readFileSync(target, 'utf8')).toBe('protected user content');
    expect(readFileSync(output, 'utf8')).toBe('protected user content');
  });

  it('refuses a preexisting stderr hardlink without modifying the target', async () => {
    const target = join(cwd, 'protected.txt');
    writeFileSync(target, 'protected user content');
    linkSync(target, join(cwd, 'worker.stderr.log'));
    await expect(run('process.stderr.write("replacement")')).rejects.toThrow('workflow_artifact_write_refused');
    expect(readFileSync(target, 'utf8')).toBe('protected user content');
  });

  function runMeasured(code: string, provider: 'glm' | 'codex' = 'glm', timeoutMs = 5000) {
    return runWorkflowProcess({ command: process.execPath, args: ['-e', code], cwd, provider, collectUsage: true,
      timeoutMs, artifactPrefix: join(cwd, 'measured') });
  }

  it('collects terminal usage beyond the captured log boundary', async () => {
    const result = await runMeasured(`
      process.stdout.write(('x'.repeat(20000)+'\\n').repeat(60));
      process.stdout.write(JSON.stringify({type:'result',subtype:'success',session_id:'12345678-1234-4123-8123-123456789abc',
        modelUsage:{glm:{inputTokens:100,outputTokens:30,cacheReadInputTokens:80,cacheCreationInputTokens:20}}})+'\\n');
    `);
    expect(result.passed).toBe(true);
    expect(result.telemetry).toMatchObject({ inputTokens: 200, outputTokens: 30, cacheReadTokens: 80, cacheWriteTokens: 20 });
    expect(result.telemetry!.durationMs).toBeGreaterThan(0);
    expect(readFileSync(result.artifacts[0]!.path, 'utf8')).not.toContain('modelUsage');
    expect(result.artifacts[0]!.sizeBytes).toBeLessThanOrEqual(1024 * 1024);
  });

  it('fails structured provider failures even when the executable exits successfully', async () => {
    const result = await runMeasured(`process.stdout.write(JSON.stringify({type:'result',subtype:'error_during_execution'})+'\\n')`);
    expect(result.passed).toBe(false);
    expect(result.error).toBe('process_failed');
    expect(result.telemetry).toMatchObject({ status: 'unknown', terminal: 'failure' });
  });

  it('requires a terminal event in measured mode but allows unavailable counters', async () => {
    const result = await runMeasured(`process.stdout.write(JSON.stringify({type:'result',subtype:'success'})+'\\n')`);
    expect(result.passed).toBe(true);
    expect(result.telemetry).toMatchObject({ status: 'unknown', terminal: 'success' });
  });

  it('fails measured process output that lacks terminal framing', async () => {
    const result = await runMeasured('process.stdout.write("legacy output")');
    expect(result.passed).toBe(false);
    expect(result.error).toBe('process_failed');
    expect(result.telemetry!.diagnostics).toContain('missing_terminal_event');
  });

  it('leaves V1 output semantics unchanged without collection enabled', async () => {
    const result = await run('process.stdout.write(JSON.stringify({type:"result",subtype:"error_during_execution"}))');
    expect(result.passed).toBe(true);
    expect(result.telemetry).toBeUndefined();
  });

  it('retains a provider-confirmed session ID after timeout without inventing usage', async () => {
    const result = await runMeasured(`process.stdout.write(JSON.stringify({type:'system',subtype:'init',
      session_id:'12345678-1234-4123-8123-123456789abc'})+'\\n'); setInterval(()=>{},1000)`, 'glm', 500);
    expect(result.error).toBe('timeout');
    expect(result.telemetry).toMatchObject({ status: 'unknown', sessionId: '12345678-1234-4123-8123-123456789abc' });
    expect(result.telemetry!.inputTokens).toBeUndefined();
  });

  it('redacts structured logs and exposes no transcript or provider errors in telemetry', async () => {
    vi.stubEnv('OMC_FIXTURE_API_TOKEN', 'fixture-sensitive-secret-12345');
    const result = await runMeasured(`process.stdout.write(JSON.stringify({type:'error',message:process.env.OMC_FIXTURE_API_TOKEN})+'\\n')`, 'codex');
    expect(result.error).toBe('process_failed');
    expect(JSON.stringify(result)).not.toContain('fixture-sensitive');
    expect(readFileSync(result.artifacts[0]!.path, 'utf8')).toContain('[REDACTED]');
  });

  it.each([0, 1])('accepts recovered Codex errors only when completion and process exit (%s) succeed', async exitCode => {
    const result = await runMeasured(`
      process.stdout.write(JSON.stringify({type:'error',message:'Reconnecting 1/5'})+'\\n');
      process.stdout.write(JSON.stringify({type:'turn.completed',usage:{input_tokens:150,cached_input_tokens:100,output_tokens:25}})+'\\n');
      process.exitCode=${exitCode};
    `, 'codex');
    expect(result.passed).toBe(exitCode === 0);
    expect(result.telemetry!.terminal).toBe('success');
    expect(result.telemetry!.diagnostics).toContain('recovered_provider_error');
    if (exitCode) expect(result.error).toBe('process_failed');
  });

  it.each(['11223344-5566-4788-99aa-bbccddeeff00', '11223344-5566-4788-99Aa-bBCCdDeEfF00'])(
    'does not return a UUID-shaped credential as provider session identity (%s)', async credential => {
      vi.stubEnv('OMC_FIXTURE_API_TOKEN', credential);
      const result = await runMeasured(`process.stdout.write(JSON.stringify({type:'result',subtype:'success',
        session_id:process.env.OMC_FIXTURE_API_TOKEN,modelUsage:{glm:{inputTokens:100,outputTokens:30,
        cacheReadInputTokens:80,cacheCreationInputTokens:20}}})+'\\n')`);
      expect(result.telemetry!.sessionId).toBeUndefined();
      expect(result.telemetry!.diagnostics).toContain('session_identity_invalid');
      expect(result.telemetry!.status).toBe('partial');
      expect(JSON.stringify(result).toLowerCase()).not.toContain(credential.toLowerCase());
      expect(readFileSync(result.artifacts[0]!.path, 'utf8')).toContain('[REDACTED]');
    },
  );
});
