import { spawn, spawnSync } from 'node:child_process';
import { dirname, isAbsolute } from 'node:path';
import { lstatSync, realpathSync } from 'node:fs';
import { writeTextArtifact, type ArtifactDescriptor } from '../shared/artifact-descriptor.js';
import { isExternalLLMDisabled } from '../lib/security-config.js';
import { ensureDirWithMode, validateResolvedPath } from './fs-utils.js';
import { createWorkflowUsageCollector, type WorkflowTelemetry } from './workflow-usage.js';

const MAX_LOG_BYTES = 1024 * 1024;

/** Redact before any captured process data reaches an artifact or caller. */
export function redactWorkflowText(text: string, caseInsensitive = false, privateEnvironment: NodeJS.ProcessEnv = {}): string {
  let redacted = text;
  const privateRedaction = Object.keys(privateEnvironment).length > 0;
  if (privateRedaction) redacted = redacted.split('\n').map(line => {
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { return line; }
    // Normalize JSON escapes before matching private values; reject unserializable deep metadata safely.
    try { return JSON.stringify(parsed); } catch { return '[unserializable structured output omitted]'; }
  }).join('\n');
  for (const [key, value] of [...Object.entries(process.env), ...Object.entries(privateEnvironment)]) {
    if (/(?:key|token|secret|password|credential|authorization)/i.test(key) && value && value.length >= 4) {
      for (const spelling of privateRedaction ? [...new Set([value, JSON.stringify(value).slice(1, -1)])] : [value]) {
        redacted = caseInsensitive
          ? redacted.replace(new RegExp(spelling.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '[REDACTED]')
          : redacted.split(spelling).join('[REDACTED]');
      }
    }
  }
  return redacted.replace(/\b(?:Bearer\s+)[A-Za-z0-9._~+\/-]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,})\b/g, '[REDACTED]')
    .replace(/((?:api[_-]?key|access[_-]?token|password|secret)\s*[=:]\s*)[^\s,;]+/gi, '$1[REDACTED]');
}

export interface WorkflowProcessResult {
  passed: boolean;
  error?: 'launch_failed' | 'timeout' | 'interrupted' | 'process_failed' | 'throttled' | 'protocol_failed';
  artifacts: ArtifactDescriptor[];
  telemetry?: WorkflowTelemetry;
}

/** One-shot execution only; no shell, transcript handoff or env serialization. */
export async function runWorkflowProcess(input: {
  command: string; args: string[]; cwd: string; stdin?: string; timeoutMs: number; artifactPrefix: string;
  provider?: WorkflowTelemetry['provider']; worker?: string; collectUsage?: boolean;
  environment?: NodeJS.ProcessEnv;
  redactionEnvironment?: NodeJS.ProcessEnv;
  /** Operation decoder receives raw bounded-protocol chunks only inside the controller. */
  onStdout?: (chunk: Buffer) => void;
}): Promise<WorkflowProcessResult> {
  if (input.provider && input.provider !== 'claude' && isExternalLLMDisabled()) throw new Error('workflow_external_llm_disabled');
  if (input.provider === 'claude' && !input.environment) throw new Error('workflow_explicit_environment_required');
  if (!input.command || /[\0\r\n]/.test(input.command) || input.args.some(arg => arg.includes('\0'))) throw new Error('workflow_invalid_process_arguments');
  if (process.platform === 'win32' && /\.(cmd|bat|ps1)$/i.test(input.command)) throw new Error('workflow_shell_wrapper_unsupported');
  const artifactParent = dirname(input.artifactPrefix);
  ensureDirWithMode(artifactParent);
  if (lstatSync(artifactParent).isSymbolicLink()) throw new Error('workflow_artifact_parent_symlink');
  const canonicalArtifactParent = realpathSync(artifactParent);
  const script = isAbsolute(input.command) && /\.(?:c?js|mjs)$/i.test(input.command);
  const command = script ? process.execPath : input.command;
  const args = script ? [input.command, ...input.args] : input.args;
  const environment = { ...(input.environment ?? process.env) };
  const redactionEnvironment = { ...input.environment, ...input.redactionEnvironment };
  // Nested Claude session identity must not route the isolated GLM wrapper back to the lead.
  delete environment.CLAUDECODE;
  delete environment.CLAUDE_CODE_ENTRYPOINT;
  delete environment.OMC_TEAM_WORKER;
  if (input.worker) {
    environment.OMC_TEAM_WORKER = input.worker;
    environment.OMC_TEAM_WORKTREE_PATH = input.cwd;
  }
  const startedAt = performance.now();
  const usage = input.collectUsage && input.provider ? createWorkflowUsageCollector(input.provider) : undefined;
  const result = await new Promise<{ code: number | null; error?: WorkflowProcessResult['error']; stdout: Buffer; stderr: Buffer }>(resolve => {
    const stdout: Buffer[] = []; const stderr: Buffer[] = [];
    let stdoutBytes = 0; let stderrBytes = 0;
    let stdoutTruncated = false; let stderrTruncated = false;
    let error: WorkflowProcessResult['error'];
    let finished = false;
    let reapTimer: ReturnType<typeof setTimeout> | undefined;
    const child = spawn(command, args, { cwd: input.cwd, env: environment, stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true, detached: process.platform !== 'win32' });
    const finish = (code: number | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer); if (reapTimer) clearTimeout(reapTimer);
      process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
      // Strip any incomplete sensitive env value at the capture boundary before redacting complete values.
      const captured = (chunks: Buffer[], truncated: boolean) => {
        const buffer = Buffer.concat(chunks);
        if (!truncated) return buffer;
        let tailSafe = buffer.toString('utf8');
        if (Object.keys(redactionEnvironment).length) {
          const lastLine = tailSafe.lastIndexOf('\n') + 1;
          if (/^\s*[\[{]/.test(tailSafe.slice(lastLine))) tailSafe = tailSafe.slice(0, lastLine);
        }
        for (const [key, value] of [...Object.entries(process.env), ...Object.entries(redactionEnvironment)]) {
          if (!/(?:key|token|secret|password|credential|authorization)/i.test(key) || !value || value.length < 4) continue;
          for (let length = Math.min(value.length - 1, tailSafe.length); length > 0; length--) {
            if (tailSafe.endsWith(value.slice(0, length))) { tailSafe = tailSafe.slice(0, -length); break; }
          }
        }
        return Buffer.from(`${redactWorkflowText(tailSafe, false, redactionEnvironment).slice(0, MAX_LOG_BYTES - 64)}\n[output truncated]\n`);
      };
      resolve({ code, error, stdout: captured(stdout, stdoutTruncated), stderr: captured(stderr, stderrTruncated) });
    };
    const terminate = () => {
      if (child.pid) {
        try {
          if (process.platform === 'win32') spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 2000, shell: false });
          else process.kill(-child.pid, 'SIGKILL');
        } catch { child.kill('SIGKILL'); }
      }
      reapTimer = setTimeout(() => {
        child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy(); child.unref(); finish(null);
      }, 2000);
    };
    const interrupt = () => { error = 'interrupted'; terminate(); };
    process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
    const timer = setTimeout(() => { error = 'timeout'; terminate(); }, input.timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      usage?.write(chunk);
      if (!error) {
        try { input.onStdout?.(chunk); }
        catch { error = 'protocol_failed'; terminate(); }
      }
      const kept = chunk.subarray(0, Math.max(0, MAX_LOG_BYTES - stdoutBytes));
      if (kept.length) stdout.push(kept);
      stdoutTruncated ||= kept.length < chunk.length; stdoutBytes += kept.length;
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const kept = chunk.subarray(0, Math.max(0, MAX_LOG_BYTES - stderrBytes));
      if (kept.length) stderr.push(kept);
      stderrTruncated ||= kept.length < chunk.length; stderrBytes += kept.length;
    });
    child.on('error', () => { error = 'launch_failed'; });
    child.stdin.on('error', () => { /* EPIPE is reflected in the exit status. */ });
    child.on('close', finish);
    child.stdin.end(input.stdin ?? '');
  });
  // Aggregate before redaction so secrets split across process chunks cannot escape.
  if (lstatSync(artifactParent).isSymbolicLink() || realpathSync(artifactParent) !== canonicalArtifactParent) throw new Error('workflow_artifact_parent_changed');
  const artifacts = (['stdout', 'stderr'] as const).map(stream => {
    const path = `${input.artifactPrefix}.${stream}.log`;
    try {
      validateResolvedPath(path, canonicalArtifactParent);
      return writeTextArtifact({ path, content: redactWorkflowText(result[stream].toString('utf8'), false, redactionEnvironment), exclusive: true,
        kind: `workflow-${stream}`, producer: { system: 'omc', component: 'team-workflow', worker: input.worker }, retention: 'until-completion' });
    } catch { throw new Error('workflow_artifact_write_refused'); }
  });
  const telemetry = usage?.finish({ durationMs: performance.now() - startedAt, passed: result.code === 0 && !result.error });
  // UUID shape is not proof that an identity is safe: it can still echo a known credential.
  // Compare without case because the collector canonicalizes UUIDs to lowercase.
  if (telemetry?.sessionId && redactWorkflowText(telemetry.sessionId, true, redactionEnvironment) !== telemetry.sessionId) {
    delete telemetry.sessionId;
    telemetry.diagnostics = [...new Set([...(telemetry.diagnostics ?? []), 'session_identity_invalid'])].sort();
    if (telemetry.status === 'measured') telemetry.status = 'partial';
  }
  const failure = result.error ?? (result.code !== 0
    ? /\b429\b|rate[_ -]?limit|too many requests/i.test(`${result.stdout.toString('utf8')}\n${result.stderr.toString('utf8')}`) ? 'throttled' : 'process_failed'
    : telemetry && telemetry.terminal !== 'success' ? 'process_failed' : undefined);
  return { passed: result.code === 0 && !failure, ...(failure ? { error: failure } : {}), artifacts, ...(telemetry ? { telemetry } : {}) };
}
