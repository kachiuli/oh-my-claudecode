import { existsSync, linkSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runWorkflowProcess } from '../workflow-process.js';
import { superviseWindowsWorkflowInvocation } from '../workflow-process-supervisor.js';
import { resolveValidatedCliInvocation } from '../model-contract.js';

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

  it.runIf(process.platform === 'win32')('runs an explicitly quoted batch invocation without shell mode', async () => {
    const shim = join(cwd, 'codex.cmd');
    const script = 'process.stdout.write(JSON.stringify(process.argv.slice(1)))';
    writeFileSync(shim, `@echo off\r\n"${process.execPath}" -e "${script}" %*\r\n`);
    const expected = ['exec', '--model', 'space and & literal', 'bang!literal', 'caret^literal', 'quote"literal'];
    const invocation = resolveValidatedCliInvocation('codex', expected, shim);
    // This checks argv quoting, not timeout behavior; cold PowerShell startup can exceed 5s on CI.
    const result = await runWorkflowProcess({ ...invocation, cwd, timeoutMs: 30_000,
      artifactPrefix: join(cwd, 'windows-batch'), superviseProcessTree: true });
    expect(result.error).toBeUndefined();
    expect(result.passed).toBe(true);
    expect(JSON.parse(readFileSync(result.artifacts[0]!.path, 'utf8'))).toEqual(expected);
  }, 40_000);

  it.each([undefined, 'claude', 'codex', 'glm'] as const)('removes lead lease credentials from a %s child', async provider => {
    vi.stubEnv('OMC_ORCHESTRATOR_LEASE_TOKEN', 'fixture-lease-token');
    vi.stubEnv('OMC_ORCHESTRATOR_HOST', 'codex');
    const result = await runWorkflowProcess({ command: process.execPath,
      args: ['-e', 'process.stdout.write(JSON.stringify(Object.keys(process.env).filter(key=>key.startsWith("OMC_ORCHESTRATOR_"))))'],
      cwd, provider, timeoutMs: 5000, environment: { ...process.env }, artifactPrefix: join(cwd, 'isolated') });
    expect(result.passed).toBe(true);
    expect(JSON.parse(readFileSync(result.artifacts[0]!.path, 'utf8'))).toEqual([]);
  });

  it('marks a review or verification child as a subordinate workflow process', async () => {
    const result = await runWorkflowProcess({ command: process.execPath,
      args: ['-e', 'process.stdout.write(JSON.stringify({worker:process.env.OMC_TEAM_WORKER,name:process.env.OMC_TEAM_WORKER_NAME,worktree:process.env.OMC_TEAM_WORKTREE_PATH}))'],
      cwd, provider: 'codex', timeoutMs: 5000, environment: { ...process.env }, artifactPrefix: join(cwd, 'subordinate') });
    expect(result.passed).toBe(true);
    expect(JSON.parse(readFileSync(result.artifacts[0]!.path, 'utf8'))).toEqual({ name: 'workflow-process', worktree: cwd });
  });

  it.each(['claude', 'codex', 'glm'] as const)('isolates %s provider authentication from the other native host', async provider => {
    const environment = { ...process.env, OPENAI_API_KEY: 'fixture-openai-key', CODEX_HOME: '/fixture/codex',
      ANTHROPIC_API_KEY: 'fixture-anthropic-key', CLAUDE_CONFIG_DIR: '/fixture/claude', ZAI_API_KEY: 'fixture-zai-key' };
    const result = await runWorkflowProcess({ command: process.execPath,
      args: ['-e', 'process.stdout.write(JSON.stringify(Object.keys(process.env).filter(key=>["OPENAI_API_KEY","CODEX_HOME","ANTHROPIC_API_KEY","CLAUDE_CONFIG_DIR","ZAI_API_KEY"].includes(key)).sort()))'],
      cwd, provider, timeoutMs: 5000, environment, artifactPrefix: join(cwd, 'auth') });
    expect(result.passed).toBe(true);
    expect(JSON.parse(readFileSync(result.artifacts[0]!.path, 'utf8'))).toEqual(provider === 'codex'
      ? ['CODEX_HOME', 'OPENAI_API_KEY'] : provider === 'glm'
        ? ['ANTHROPIC_API_KEY', 'CLAUDE_CONFIG_DIR', 'ZAI_API_KEY'] : ['ANTHROPIC_API_KEY', 'CLAUDE_CONFIG_DIR']);
  });

  it('keeps the legacy GLM wrapper isolated from inherited Claude OAuth credentials', async () => {
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'fixture-claude-oauth');
    vi.stubEnv('ANTHROPIC_API_KEY', 'fixture-anthropic-key');
    vi.stubEnv('CLAUDE_CONFIG_DIR', '/fixture/claude');
    const result = await runWorkflowProcess({ command: process.execPath,
      args: ['-e', 'process.stdout.write(JSON.stringify(Object.keys(process.env).filter(key=>/^(?:CLAUDE_|ANTHROPIC_)/i.test(key))))'],
      cwd, provider: 'glm', timeoutMs: 5000, artifactPrefix: join(cwd, 'legacy-auth') });
    expect(result.passed).toBe(true);
    expect(JSON.parse(readFileSync(result.artifacts[0]!.path, 'utf8'))).toEqual([]);
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

  it('filters thinking-token progress before the cap and retains the terminal event', async () => {
    const result = await runMeasured(`
      const progress = JSON.stringify({type:'system',subtype:'thinking_tokens',estimated_tokens_delta:1})+'\\n';
      process.stdout.write(progress.repeat(Math.ceil((1024*1024)/Buffer.byteLength(progress))+1000));
      process.stdout.write(JSON.stringify({type:'result',subtype:'success',session_id:'12345678-1234-4123-8123-123456789abc',
        modelUsage:{glm:{inputTokens:100,outputTokens:30,cacheReadInputTokens:80,cacheCreationInputTokens:20}}})+'\\n');
    `);
    expect(result.passed).toBe(true);
    expect(result.telemetry).toMatchObject({ inputTokens: 200, outputTokens: 30, cacheReadTokens: 80, cacheWriteTokens: 20 });
    expect(result.telemetry!.durationMs).toBeGreaterThan(0);
    const output = readFileSync(result.artifacts[0]!.path, 'utf8');
    expect(output).toContain('modelUsage');
    expect(output).not.toContain('thinking_tokens');
    expect(result.stdoutTruncated).toBe(false);
    expect(result.artifacts[0]!.sizeBytes).toBeLessThanOrEqual(1024 * 1024);
  });

  it('retains malformed thinking-token and ordinary stream-json records', async () => {
    const result = await runMeasured(`
      process.stdout.write('{"type":"system","subtype":"thinking_tokens"\\n');
      process.stdout.write(JSON.stringify({type:'system',subtype:'status',message:'working'})+'\\n');
      process.stdout.write(JSON.stringify({type:'result',subtype:'success'})+'\\n');
    `);
    expect(result.passed).toBe(true);
    const output = readFileSync(result.artifacts[0]!.path, 'utf8');
    expect(output).toContain('{"type":"system","subtype":"thinking_tokens"');
    expect(output).toContain('"subtype":"status"');
    expect(output).toContain('"type":"result"');
  });

  it('bounds capture for many short ordinary stream-json records', async () => {
    const result = await runMeasured(`
      process.stdout.write('{}\\n'.repeat(400000));
      process.stdout.write(JSON.stringify({type:'result',subtype:'success'})+'\\n');
    `);
    expect(result.passed).toBe(true);
    expect(result.stdoutTruncated).toBe(true);
    expect(result.artifacts[0]!.sizeBytes).toBeLessThanOrEqual(1024 * 1024);
  });

  it('retains the terminal event after high-volume ordinary stream-json output', async () => {
    const result = await runMeasured(`
      const progress = JSON.stringify({type:'system',subtype:'compaction',preserved_messages:'x'.repeat(2000)})+'\\n';
      process.stdout.write(progress.repeat(600));
      process.stdout.write(JSON.stringify({type:'result',subtype:'success',
        session_id:'12345678-1234-4123-8123-123456789abc',
        modelUsage:{glm:{inputTokens:100,outputTokens:30,cacheReadInputTokens:80,cacheCreationInputTokens:20}}})+'\\n');
    `);
    expect(result.passed).toBe(true);
    expect(result.stdoutTruncated).toBe(true);
    expect(result.telemetry).toMatchObject({ terminal: 'success' });
    expect(result.telemetry?.diagnostics ?? []).not.toContain('process_failed');
    const output = readFileSync(result.artifacts[0]!.path, 'utf8');
    expect(output.includes('"type":"result"')).toBe(true);
    expect(result.artifacts[0]!.sizeBytes).toBeLessThanOrEqual(1024 * 1024);
  });

  it('keeps only complete records when a credential crosses the retained stdout boundary', async () => {
    vi.stubEnv('OMC_FIXTURE_API_TOKEN', 'splice-sensitive-credential-1234567890');
    const result = await runMeasured(`
      const secret = process.env.OMC_FIXTURE_API_TOKEN;
      const split = 12;
      const terminal = JSON.stringify({type:'result',subtype:'success'})+'\\n';
      const fillerBytes = 1024*1024-Buffer.byteLength(secret.slice(split))-2-Buffer.byteLength(terminal);
      process.stdout.write('{}\\n'.repeat(1000));
      process.stdout.write(secret+'\\n');
      process.stdout.write('x'.repeat(fillerBytes)+'\\n');
      process.stdout.write(terminal);
    `);
    expect(result.passed).toBe(true);
    expect(result.stdoutTruncated).toBe(true);
    const output = readFileSync(result.artifacts[0]!.path, 'utf8');
    expect(output.includes('splice-sensitive')).toBe(false);
    expect(output.includes('credential-1234567890')).toBe(false);
    expect(output.includes('"type":"result"')).toBe(true);
    expect(result.artifacts[0]!.sizeBytes).toBeLessThanOrEqual(1024 * 1024);
  });

  it('drops a partial private JSON record at the retained stdout end', async () => {
    const secret = 'tail-partial-sensitive-credential-1234567890';
    const result = await runWorkflowProcess({ command: process.execPath, args: ['-e', `
      const progress = JSON.stringify({type:'system',subtype:'compaction',preserved_messages:'x'.repeat(2000)})+'\\n';
      process.stdout.write(progress.repeat(600));
      process.stdout.write(JSON.stringify({type:'result',subtype:'success'})+'\\n');
      process.stdout.write('{"type":"PARTIAL_PRIVATE_RECORD","message":"'+${JSON.stringify(secret)}.slice(0,18));
    `], cwd, provider: 'glm', collectUsage: true, timeoutMs: 5000, artifactPrefix: join(cwd, 'partial-tail'),
    environment: {}, redactionEnvironment: { OMC_FIXTURE_API_TOKEN: secret } });
    expect(result.passed).toBe(true);
    const output = readFileSync(result.artifacts[0]!.path, 'utf8');
    expect(output.includes('PARTIAL_PRIVATE_RECORD')).toBe(false);
    expect(output.includes('tail-partial')).toBe(false);
    expect(output.includes('"type":"result"')).toBe(true);
    expect(result.artifacts[0]!.sizeBytes).toBeLessThanOrEqual(1024 * 1024);
  });

  it('drops incomplete trailing JSON containing a prefix of an inherited secret', async () => {
    vi.stubEnv('OMC_FIXTURE_API_TOKEN', 'splice-sensitive-credential-1234567890');
    const result = await runMeasured(`
      const progress = JSON.stringify({type:'system',subtype:'compaction',preserved_messages:'x'.repeat(2000)})+'\\n';
      process.stdout.write(progress.repeat(600));
      process.stdout.write(JSON.stringify({type:'result',subtype:'success'})+'\\n');
      process.stdout.write('{"type":"error","message":"'+process.env.OMC_FIXTURE_API_TOKEN.slice(0,16)+'","unfinished":"x');
    `);
    expect(result.passed).toBe(true);
    const output = readFileSync(result.artifacts[0]!.path, 'utf8');
    expect(output.includes('splice-sensitive')).toBe(false);
    expect(output.includes('"unfinished":"x')).toBe(false);
    expect(output.includes('"type":"result"')).toBe(true);
  });

  it('retains a valid terminal JSON record without a trailing newline', async () => {
    const result = await runMeasured(`
      const progress = JSON.stringify({type:'system',subtype:'compaction',preserved_messages:'x'.repeat(2000)})+'\\n';
      process.stdout.write(progress.repeat(600));
      process.stdout.write(JSON.stringify({type:'result',subtype:'success'}));
    `);
    expect(result.passed).toBe(true);
    expect(result.stdoutTruncated).toBe(true);
    const output = readFileSync(result.artifacts[0]!.path, 'utf8');
    expect(output.includes('"type":"result"')).toBe(true);
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

describe('explicit no-wall process execution', () => {
  let cwd: string;
  beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), 'omc-workflow-no-wall-')); });
  // A helper that deliberately outlives the controller can still hold the directory as its cwd on Windows.
  afterEach(() => rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  function runUnbounded(code: string, prefix: string) {
    return runWorkflowProcess({ command: process.execPath, args: ['-e', code], cwd, timeoutMs: null,
      artifactPrefix: join(cwd, prefix) });
  }

  it.runIf(process.platform === 'win32')('supervises a provider without consuming its stdin or stdout', async () => {
    const result = await runWorkflowProcess({ command: process.execPath, args: ['-e', `
      const fs = require('node:fs');
      const emptyKey = Object.keys(process.env).find(key => key.toUpperCase() === 'OMC_FIXTURE_EMPTY');
      process.stdout.write(JSON.stringify({ prompt: fs.readFileSync(0, 'utf8'),
        intended: process.env.OMC_FIXTURE_ENV,
        emptyPresent: emptyKey !== undefined, emptyValue: emptyKey === undefined ? null : process.env[emptyKey],
        injectedPathExt: Object.keys(process.env).some(key => key.toUpperCase() === 'PATHEXT'),
        injectedModulePath: Object.keys(process.env).some(key => key.toUpperCase() === 'PSMODULEPATH'),
        internalConfig: Object.keys(process.env).some(key => key.toUpperCase() === 'OMC_WORKFLOW_PROCESS_SUPERVISOR') }));
    `], cwd, stdin: 'controller prompt', timeoutMs: null, superviseProcessTree: true,
    environment: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, TEMP: process.env.TEMP, TMP: process.env.TMP,
      OMC_FIXTURE_ENV: 'preserved', OMC_FIXTURE_EMPTY: '', omc_workflow_process_supervisor: 'caller-value' },
    artifactPrefix: join(cwd, 'supervised-stdio') });
    expect(result).toMatchObject({ passed: true, settlement: { outputComplete: true, descendants: 'cleaned' } });
    expect(JSON.parse(readFileSync(result.artifacts[0]!.path, 'utf8')))
      .toEqual({ prompt: 'controller prompt', intended: 'preserved', emptyPresent: true, emptyValue: '', injectedPathExt: false,
        injectedModulePath: false, internalConfig: false });
  }, 90000);

  it.runIf(process.platform === 'win32')('carries only known PowerShell startup mutations as exact environment repairs', () => {
    const supervised = superviseWindowsWorkflowInvocation({ command: process.execPath, args: ['-e', ''], cwd,
      environment: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH,
        pSmOdUlEpAtH: 'C:\\fixture\\modules', PathExt: '.FIXTURE;.EXE', __compat_layer: '' } });
    const commandLineLength = supervised.command.length + 2
      + supervised.args.reduce((length, argument) => length + argument.length, 0) + supervised.args.length;
    expect(commandLineLength).toBeLessThanOrEqual(32_000);
    expect(Object.keys(supervised.environment)
      .filter(key => ['PSMODULEPATH', 'PATHEXT', '__COMPAT_LAYER'].includes(key.toUpperCase())))
      .toEqual([]);
    const configKey = Object.keys(supervised.environment)
      .find(key => key.toUpperCase() === 'OMC_WORKFLOW_PROCESS_SUPERVISOR')!;
    const configuration = JSON.parse(Buffer.from(supervised.environment[configKey]!, 'base64').toString('utf8'));
    expect(configuration.environment_repairs).toEqual([
      { name: 'PathExt', value: '.FIXTURE;.EXE' },
      { name: 'pSmOdUlEpAtH', value: 'C:\\fixture\\modules' },
      { name: '__compat_layer', value: '' },
    ]);
  });

  it.runIf(process.platform === 'win32')('restores exact repairable provider environment values after supervisor startup', async () => {
    const result = await runWorkflowProcess({ command: process.execPath, args: ['-e', `
      const entry = name => {
        const key = Object.keys(process.env).find(key => key.toUpperCase() === name);
        return { key, value: key === undefined ? null : process.env[key] };
      };
      process.stdout.write(JSON.stringify({ modulePath: entry('PSMODULEPATH'), pathExt: entry('PATHEXT'),
        compatLayer: entry('__COMPAT_LAYER') }));
    `], cwd, timeoutMs: null, superviseProcessTree: true,
      environment: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, TEMP: process.env.TEMP, TMP: process.env.TMP,
        pSmOdUlEpAtH: 'C:\\fixture\\modules', PathExt: '.FIXTURE;.EXE', __compat_layer: 'RunAsInvoker' },
      artifactPrefix: join(cwd, 'supervised-repaired-environment') });
    expect(result.passed).toBe(true);
    expect(JSON.parse(readFileSync(result.artifacts[0]!.path, 'utf8'))).toEqual({
      modulePath: { key: 'pSmOdUlEpAtH', value: 'C:\\fixture\\modules' },
      pathExt: { key: 'PathExt', value: '.FIXTURE;.EXE' },
      compatLayer: { key: '__compat_layer', value: 'RunAsInvoker' },
    });
  }, 90000);

  it.runIf(process.platform === 'win32')('preserves an explicitly empty provider module path', async () => {
    const result = await runWorkflowProcess({ command: process.execPath, args: ['-e', `
      const key = Object.keys(process.env).find(name => name.toUpperCase() === 'PSMODULEPATH');
      process.stdout.write(JSON.stringify({ present: key !== undefined, value: key === undefined ? null : process.env[key] }));
    `], cwd, timeoutMs: null, superviseProcessTree: true,
    environment: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, TEMP: process.env.TEMP, TMP: process.env.TMP,
      PSModulePath: '' }, artifactPrefix: join(cwd, 'supervised-empty-module-path') });
    expect(result.passed).toBe(true);
    expect(JSON.parse(readFileSync(result.artifacts[0]!.path, 'utf8'))).toEqual({ present: true, value: '' });
  }, 90000);

  it.runIf(process.platform === 'win32')('fails closed when an intended provider environment value changes', async () => {
    const supervised = superviseWindowsWorkflowInvocation({ command: process.execPath,
      args: ['-e', 'process.stdout.write("must-not-run")'], cwd,
      environment: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, TEMP: process.env.TEMP, TMP: process.env.TMP,
        OMC_FIXTURE_ENV: 'intended-value' } });
    const configKey = Object.keys(supervised.environment)
      .find(key => key.toUpperCase() === 'OMC_WORKFLOW_PROCESS_SUPERVISOR')!;
    expect(Buffer.from(supervised.environment[configKey]!, 'base64').toString('utf8')).not.toContain('intended-value');
    supervised.environment.OMC_FIXTURE_ENV = 'changed-after-digest';
    const result = await runWorkflowProcess({ ...supervised, cwd, timeoutMs: 60000,
      artifactPrefix: join(cwd, 'supervised-environment-mismatch') });
    expect(result).toMatchObject({ passed: false, error: 'process_failed' });
    expect(readFileSync(result.artifacts[0]!.path, 'utf8')).toBe('');
    expect(readFileSync(result.artifacts[1]!.path, 'utf8')).toContain('workflow_supervisor_environment_mismatch');
  }, 90000);

  it.runIf(process.platform === 'win32')('rejects an arbitrary provider environment repair', async () => {
    const supervised = superviseWindowsWorkflowInvocation({ command: process.execPath,
      args: ['-e', 'process.stdout.write("must-not-run")'], cwd,
      environment: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, TEMP: process.env.TEMP, TMP: process.env.TMP,
        OMC_FIXTURE_ENV: 'intended-value' } });
    const configKey = Object.keys(supervised.environment)
      .find(key => key.toUpperCase() === 'OMC_WORKFLOW_PROCESS_SUPERVISOR')!;
    const configuration = JSON.parse(Buffer.from(supervised.environment[configKey]!, 'base64').toString('utf8'));
    configuration.environment_repairs.push({ name: 'OMC_FIXTURE_ENV', value: 'intended-value' });
    supervised.environment[configKey] = Buffer.from(JSON.stringify(configuration), 'utf8').toString('base64');
    delete supervised.environment.OMC_FIXTURE_ENV;
    const result = await runWorkflowProcess({ ...supervised, cwd, timeoutMs: 60000,
      artifactPrefix: join(cwd, 'supervised-environment-repair-invalid') });
    expect(result).toMatchObject({ passed: false, error: 'process_failed' });
    expect(readFileSync(result.artifacts[0]!.path, 'utf8')).toBe('');
    expect(readFileSync(result.artifacts[1]!.path, 'utf8')).toContain('workflow_supervisor_environment_repair_invalid');
  }, 90000);

  it.runIf(process.platform === 'win32')('refuses a NUL-bearing provider argument before launch', async () => {
    const marker = join(cwd, 'nul-argument-provider-ran');
    const provider = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`;
    await expect(runWorkflowProcess({ command: process.execPath,
      args: ['-e', provider, 'before\0after'], cwd, timeoutMs: null, superviseProcessTree: true,
      artifactPrefix: join(cwd, 'nul-argument') })).rejects.toThrow('workflow_invalid_process_arguments');
    expect(existsSync(marker)).toBe(false);
  });

  it.runIf(process.platform === 'win32')('refuses a NUL-bearing provider environment before launch', async () => {
    const marker = join(cwd, 'nul-environment-provider-ran');
    const provider = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`;
    await expect(runWorkflowProcess({ command: process.execPath, args: ['-e', provider], cwd,
      timeoutMs: null, superviseProcessTree: true,
      environment: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH,
        PSModulePath: 'foo\0OMC_INJECTED=yes' }, artifactPrefix: join(cwd, 'nul-environment') }))
      .rejects.toThrow('workflow_supervisor_environment_invalid');
    expect(existsSync(marker)).toBe(false);
  });

  it.runIf(process.platform === 'win32')('refuses invalid or aliased Windows environment keys', () => {
    const base = { command: process.execPath, args: ['-e', ''], cwd };
    expect(() => superviseWindowsWorkflowInvocation({ ...base,
      environment: { SystemRoot: process.env.SystemRoot, 'BAD=KEY': 'value' } }))
      .toThrow('workflow_supervisor_environment_invalid');
    expect(() => superviseWindowsWorkflowInvocation({ ...base,
      environment: { SystemRoot: process.env.SystemRoot, PATH: 'first', Path: 'second' } }))
      .toThrow('workflow_supervisor_environment_invalid');
    expect(() => superviseWindowsWorkflowInvocation({ ...base, args: ['before\0after'], environment: process.env }))
      .toThrow('workflow_supervisor_process_arguments_invalid');
    expect(() => superviseWindowsWorkflowInvocation({ ...base, cwd: `${cwd}\0other`, environment: process.env }))
      .toThrow('workflow_supervisor_process_arguments_invalid');
  });

  it.runIf(process.platform === 'win32')('kills inherited detached descendants before accepting provider success', async () => {
    const marker = join(cwd, 'late-descendant-marker');
    const descendant = `setTimeout(() => require('node:fs').writeFileSync(process.argv[1], 'late'), 700); setTimeout(() => {}, 1200)`;
    const result = await runWorkflowProcess({ command: process.execPath, args: ['-e', `
      const { spawn } = require('node:child_process');
      spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}, ${JSON.stringify(marker)}],
        { stdio: ['ignore', 'inherit', 'inherit'], detached: true, windowsHide: true }).unref();
      process.stdout.write('provider-complete');
    `], cwd, timeoutMs: null, superviseProcessTree: true,
    artifactPrefix: join(cwd, 'supervised-descendant') });
    expect(result).toMatchObject({ passed: true, settlement: { outputComplete: true, descendants: 'cleaned' } });
    expect(readFileSync(result.artifacts[0]!.path, 'utf8')).toBe('provider-complete');
    await new Promise(resolve => setTimeout(resolve, 900));
    expect(existsSync(marker)).toBe(false);
  }, 90000);

  it.runIf(process.platform === 'win32')('preserves a supervised provider failure exit', async () => {
    const result = await runWorkflowProcess({ command: process.execPath,
      args: ['-e', 'process.stdout.write("failed-provider"); process.exitCode=17'], cwd,
      timeoutMs: null, superviseProcessTree: true, artifactPrefix: join(cwd, 'supervised-failure') });
    expect(result).toMatchObject({ passed: false, error: 'process_failed', parentExitedSuccessfully: false,
      settlement: { parentExitCode: 17, outputComplete: true } });
    expect(readFileSync(result.artifacts[0]!.path, 'utf8')).toBe('failed-provider');
  }, 90000);

  it.runIf(process.platform === 'win32')('preserves a supervised Windows crash exit code', async () => {
    const crashCode = 0xc0000005;
    const result = await runWorkflowProcess({ command: process.execPath,
      args: ['-e', `process.exit(${crashCode})`], cwd,
      timeoutMs: null, superviseProcessTree: true, artifactPrefix: join(cwd, 'supervised-crash') });
    expect(result).toMatchObject({ passed: false, error: 'process_failed',
      settlement: { parentExitCode: crashCode, outputComplete: true } });
  }, 90000);

  it('leaves an explicitly unbounded process running past the finite deadline that still ends a bounded one', async () => {
    const bounded = await runWorkflowProcess({ command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], cwd,
      timeoutMs: 400, artifactPrefix: join(cwd, 'bounded') });
    expect(bounded).toMatchObject({ passed: false, error: 'timeout' });
    // Bounded results keep their existing shape: no settlement metadata is invented for them.
    expect(bounded.settlement).toBeUndefined();
    const unbounded = await runUnbounded('setTimeout(() => process.stdout.write("completed"), 1200)', 'unbounded');
    expect(unbounded.passed).toBe(true);
    expect(unbounded.settlement).toEqual({ parentExitCode: 0, parentExitSignal: null, outputComplete: true,
      termination: 'not-requested', directChild: 'exited', descendants: 'unverified' });
    expect(readFileSync(unbounded.artifacts[0]!.path, 'utf8')).toBe('completed');
  });

  it.each([undefined, 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, 2147483648])(
    'refuses the invalid lifetime bound %s before any artifact or child exists', async timeoutMs => {
      const prefix = join(cwd, 'invalid');
      await expect(runWorkflowProcess({ command: process.execPath, args: ['-e', 'process.stdout.write("spawned")'], cwd,
        timeoutMs: timeoutMs as number, artifactPrefix: prefix })).rejects.toThrow('workflow_invalid_timeout');
      expect(existsSync(`${prefix}.stdout.log`)).toBe(false);
      expect(existsSync(`${prefix}.stderr.log`)).toBe(false);
    },
  );

  it('keeps late inherited output that arrives after the parent exits inside the settlement grace', async () => {
    const result = await runUnbounded(`
      const { spawn } = require('node:child_process');
      spawn(process.execPath, ['-e', 'setTimeout(() => process.stdout.write("late-output"), 400); setTimeout(() => process.exit(0), 600)'],
        { stdio: ['ignore', 'inherit', 'inherit'], detached: true, windowsHide: true });
      setTimeout(() => process.exit(0), 50);
    `, 'late');
    expect(result.passed).toBe(true);
    expect(result.settlement).toEqual({ parentExitCode: 0, parentExitSignal: null, outputComplete: true,
      termination: 'not-requested', directChild: 'exited', descendants: 'unverified' });
    expect(readFileSync(result.artifacts[0]!.path, 'utf8')).toBe('late-output');
  });

  it('settles output_incomplete without a lifetime kill when inherited pipes outlive the grace', async () => {
    const startedAt = Date.now();
    const result = await runUnbounded(`
      const { spawn } = require('node:child_process');
      spawn(process.execPath, ['-e', 'setTimeout(() => {}, 3000)'],
        { stdio: ['ignore', 'inherit', 'inherit'], detached: true, windowsHide: true, cwd: require('node:os').tmpdir() });
      setTimeout(() => process.exit(0), 50);
    `, 'incomplete');
    expect(result.passed).toBe(false);
    expect(result.error).toBe('output_incomplete');
    // The exited parent already reported success; the abandoned pipes are what make this unsuccessful.
    expect(result.settlement).toEqual({ parentExitCode: 0, parentExitSignal: null, outputComplete: false,
      termination: 'not-requested', directChild: 'exited', descendants: 'unverified' });
    expect(result.artifacts).toHaveLength(2);
    expect(Date.now() - startedAt).toBeLessThan(30_000);
  });

  it('does not label a clean provider exit as process_failed when inherited output remains open', async () => {
    const result = await runWorkflowProcess({ command: process.execPath, args: ['-e', `
      const { spawn } = require('node:child_process');
      process.stdout.write(JSON.stringify({type:'result',subtype:'success',
        session_id:'12345678-1234-4123-8123-123456789abc',
        modelUsage:{glm:{inputTokens:100,outputTokens:30,cacheReadInputTokens:80,cacheCreationInputTokens:20}}})+'\\n');
      spawn(process.execPath, ['-e', 'setTimeout(() => {}, 3000)'],
        { stdio: ['ignore', 'inherit', 'inherit'], detached: true, windowsHide: true, cwd: require('node:os').tmpdir() });
      setTimeout(() => process.exit(0), 50);
    `], cwd, provider: 'glm', collectUsage: true, timeoutMs: null, artifactPrefix: join(cwd, 'measured-incomplete') });
    expect(result).toMatchObject({ passed: false, error: 'output_incomplete',
      settlement: { parentExitCode: 0, parentExitSignal: null, outputComplete: false },
      telemetry: { status: 'partial', terminal: 'success' } });
    expect(result.telemetry?.diagnostics).toContain('output_incomplete');
    expect(result.telemetry?.diagnostics ?? []).not.toContain('process_failed');
  });

  it.skipIf(process.platform === 'win32')('retains finite timeout termination of the inherited group after parent exit', async () => {
    const marker = join(cwd, 'descendant-survived');
    const descendant = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'survived'), 1500)`;
    const code = `const {spawn} = require('node:child_process');
      spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {stdio: ['ignore', 'inherit', 'inherit']});
      setTimeout(() => process.exit(0), 50);`;
    const result = await runWorkflowProcess({ command: process.execPath, args: ['-e', code], cwd,
      timeoutMs: 400, artifactPrefix: join(cwd, 'finite-parent-exit') });
    expect(result).toMatchObject({ passed: false, error: 'timeout' });
    expect(result.settlement).toBeUndefined();
    // The descendant would have written this marker before its natural stream close.
    expect(existsSync(marker)).toBe(false);
  });

  it('settles an explicit interruption once with bounded no-wall settlement metadata', async () => {
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const running = runWorkflowProcess({ command: process.execPath, args: ['-e', 'process.stdout.write("ready"); setInterval(()=>{},1000)'],
      cwd, timeoutMs: null, artifactPrefix: join(cwd, 'interrupted'), onStdout: started });
    await ready;
    process.emit('SIGTERM');
    const result = await running;
    expect(result).toMatchObject({ passed: false, error: 'interrupted' });
    expect(readFileSync(result.artifacts[0]!.path, 'utf8')).toBe('ready');
    expect(Object.keys(result.settlement!).sort())
      .toEqual(['descendants', 'directChild', 'outputComplete', 'parentExitCode', 'parentExitSignal', 'termination']);
    expect(['attempted', 'failed']).toContain(result.settlement!.termination);
    expect(result.settlement!.descendants).toBe('unverified');
    expect(['exited', 'unconfirmed']).toContain(result.settlement!.directChild);
    // Settlement metadata carries no command text, output or provider content.
    expect(JSON.stringify(result.settlement)).not.toContain('ready');
    expect(JSON.stringify(result.settlement)).not.toContain('interrupted');
  });
});
