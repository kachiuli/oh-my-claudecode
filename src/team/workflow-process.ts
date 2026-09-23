import { spawn, spawnSync } from 'node:child_process';
import { dirname, isAbsolute } from 'node:path';
import { lstatSync, realpathSync } from 'node:fs';
import { writeTextArtifact, type ArtifactDescriptor } from '../shared/artifact-descriptor.js';
import { isExternalLLMDisabled } from '../lib/security-config.js';
import { ensureDirWithMode, validateResolvedPath } from './fs-utils.js';
import { createWorkflowUsageCollector, type WorkflowTelemetry } from './workflow-usage.js';
import { currentProcessStartIdentity } from './team-owner-epoch.js';
import type { WorkflowProviderProcessIdentity } from './workflow-contracts.js';

const MAX_LOG_BYTES = 1024 * 1024;
const MAX_STREAM_JSON_LINE_BYTES = 256 * 1024;
/** Largest delay a Node.js timer accepts; anything above would silently become a 1 ms timer. */
const MAX_TIMEOUT_MS = 2147483647;
/** Bounded settlement window shared by the elapsed timer and the post-exit drain. */
const SETTLEMENT_GRACE_MS = 2000;

export const WORKFLOW_PUBLICATION_ENV = Object.freeze({
  capabilityId: 'OMC_WORKFLOW_PUBLICATION_ID',
  capabilityToken: 'OMC_WORKFLOW_PUBLICATION_TOKEN',
  workflowRoot: 'OMC_WORKFLOW_PUBLICATION_ROOT',
  workflowName: 'OMC_WORKFLOW_PUBLICATION_WORKFLOW',
  stateRoot: 'OMC_WORKFLOW_PUBLICATION_STATE_ROOT',
} as const);

export type WorkflowPublicationEnvironment = Readonly<Record<(typeof WORKFLOW_PUBLICATION_ENV)[keyof typeof WORKFLOW_PUBLICATION_ENV], string>>;

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

/** Bounded, output-free account of how an explicitly unbounded run ended. */
export interface WorkflowProcessSettlement {
  parentExitCode: number | null;
  parentExitSignal: string | null;
  outputComplete: boolean;
  termination: 'not-requested' | 'attempted' | 'failed';
  directChild: 'not-started' | 'exited' | 'unconfirmed';
  descendants: 'not-started' | 'unverified';
}

export interface WorkflowProcessResult {
  passed: boolean;
  error?: 'launch_failed' | 'timeout' | 'interrupted' | 'process_failed' | 'throttled' | 'protocol_failed' | 'output_incomplete';
  artifacts: ArtifactDescriptor[];
  /** Controller evidence used to distinguish a clean provider exit from protocol/transport failures. */
  parentExitedSuccessfully: boolean;
  /** True when non-filtered stdout exceeded the bounded artifact capture. */
  stdoutTruncated: boolean;
  /** Present only for an explicitly unbounded (timeoutMs: null) run. */
  settlement?: WorkflowProcessSettlement;
  telemetry?: WorkflowTelemetry;
}

/** One-shot execution only; no shell, transcript handoff or env serialization. */
export async function runWorkflowProcess(input: {
  command: string; args: string[]; cwd: string; stdin?: string; artifactPrefix: string;
  /** Required for an already-quoted native cmd.exe /c payload. Never enables a shell. */
  windowsVerbatimArguments?: boolean;
  /** Elapsed lifetime bound in milliseconds, or null for an explicitly unbounded run. */
  timeoutMs: number | null;
  provider?: WorkflowTelemetry['provider']; worker?: string; collectUsage?: boolean;
  environment?: NodeJS.ProcessEnv;
  /** One-shot worker publication authority. Only these exact keys reach the provider. */
  publicationEnvironment?: WorkflowPublicationEnvironment;
  redactionEnvironment?: NodeJS.ProcessEnv;
  /** Operation decoder receives raw bounded-protocol chunks only inside the controller. */
  onStdout?: (chunk: Buffer) => void;
  /** Receives the spawned provider's process identity so an interrupted attempt can later be proven dead. */
  onSpawn?: (identity: WorkflowProviderProcessIdentity) => void;
}): Promise<WorkflowProcessResult> {
  if (input.provider && input.provider !== 'claude' && isExternalLLMDisabled()) throw new Error('workflow_external_llm_disabled');
  if (input.provider === 'claude' && !input.environment) throw new Error('workflow_explicit_environment_required');
  if (!input.command || /[\0\r\n]/.test(input.command) || input.args.some(arg => arg.includes('\0'))) throw new Error('workflow_invalid_process_arguments');
  if (process.platform === 'win32' && /\.(cmd|bat|ps1)$/i.test(input.command)) throw new Error('workflow_shell_wrapper_unsupported');
  // Validate the lifetime bound before any artifact path is created or a child is spawned.
  // Null is the sole unbounded value; every other invalid input is refused, never coerced to null.
  const timeoutMs = input.timeoutMs;
  if (timeoutMs !== null && (typeof timeoutMs !== 'number' || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS)) {
    throw new Error('workflow_invalid_timeout');
  }
  const noWall = timeoutMs === null;
  const artifactParent = dirname(input.artifactPrefix);
  ensureDirWithMode(artifactParent);
  if (lstatSync(artifactParent).isSymbolicLink()) throw new Error('workflow_artifact_parent_symlink');
  const canonicalArtifactParent = realpathSync(artifactParent);
  const script = isAbsolute(input.command) && /\.(?:c?js|mjs)$/i.test(input.command);
  const command = script ? process.execPath : input.command;
  const args = script ? [input.command, ...input.args] : input.args;
  const environment = { ...(input.environment ?? process.env) };
  // A provider/check is never the lead: its process must not inherit a revocable host lease.
  for (const key of Object.keys(environment)) {
    if (/^OMC_ORCHESTRATOR_/i.test(key)) delete environment[key];
    if (/^OMC_WORKFLOW_PUBLICATION_/i.test(key)) delete environment[key];
    if (input.provider === 'codex' && /^(?:ANTHROPIC_|CLAUDE_|CLAUDECODE$|OMC_GLM_|GLM_|ZAI_|Z_AI_)/i.test(key)) delete environment[key];
    if ((input.provider === 'glm' || input.provider === 'claude') && /^(?:OPENAI_|CODEX_)/i.test(key)) delete environment[key];
    if (input.provider === 'claude' && /^(?:OMC_GLM_|GLM_|ZAI_|Z_AI_)/i.test(key)) delete environment[key];
    // Legacy GLM wrappers load their own private profile; the lead's Anthropic login is unrelated.
    if (input.provider === 'glm' && !input.environment && /^(?:ANTHROPIC_|CLAUDE_|CLAUDECODE$)/i.test(key)) delete environment[key];
  }
  if (input.publicationEnvironment) {
    const expected = Object.values(WORKFLOW_PUBLICATION_ENV);
    const supplied = Object.keys(input.publicationEnvironment);
    if (supplied.length !== expected.length || supplied.some(key => !expected.includes(key as typeof expected[number]))
      || expected.some(key => !input.publicationEnvironment?.[key])) throw new Error('workflow_invalid_publication_authority');
    Object.assign(environment, input.publicationEnvironment);
  }
  const redactionEnvironment = { ...input.environment, ...input.redactionEnvironment, ...input.publicationEnvironment };
  // Nested Claude session identity must not route the isolated GLM wrapper back to the lead.
  delete environment.CLAUDECODE;
  delete environment.CLAUDE_CODE_ENTRYPOINT;
  delete environment.OMC_TEAM_WORKER;
  delete environment.OMC_TEAM_WORKER_NAME;
  delete environment.OMC_TEAM_WORKTREE_PATH;
  if (input.worker) {
    environment.OMC_TEAM_WORKER = input.worker;
    environment.OMC_TEAM_WORKTREE_PATH = input.cwd;
  } else {
    // Reviews and verification commands are also subordinate workflow processes. Keep that
    // authority boundary on descendants that outlive the controller operation lock.
    environment.OMC_TEAM_WORKER_NAME = 'workflow-process';
    environment.OMC_TEAM_WORKTREE_PATH = input.cwd;
  }
  const startedAt = performance.now();
  const usage = input.collectUsage && input.provider ? createWorkflowUsageCollector(input.provider) : undefined;
  const result = await new Promise<{ code: number | null; error?: WorkflowProcessResult['error']; stdout: Buffer; stderr: Buffer;
    stdoutTruncated: boolean; settlement?: WorkflowProcessSettlement }>(resolve => {
    const retainStdoutTail = usage !== undefined;
    let stdout: Buffer | undefined; const stderr: Buffer[] = [];
    let stdoutBytes = 0; let stdoutOffset = 0; let stdoutObservedBytes = 0; let stderrBytes = 0;
    let stdoutTruncated = false; let stderrTruncated = false;
    let error: WorkflowProcessResult['error'];
    let finished = false;
    let reapTimer: ReturnType<typeof setTimeout> | undefined;
    let settlementTimer: ReturnType<typeof setTimeout> | undefined;
    // An unbounded run reports only what was observed: an exited parent is never signalled again,
    // and inherited pipes that outlive it are abandoned rather than attributed to a process we cannot see.
    let started = false;
    let parentExit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    let termination: WorkflowProcessSettlement['termination'] = 'not-requested';
    let streamClose = false;
    const child = spawn(command, args, { cwd: input.cwd, env: environment, stdio: ['pipe', 'pipe', 'pipe'], shell: false,
      windowsHide: true, ...(input.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}), detached: process.platform !== 'win32' });
    if (child.pid && input.onSpawn) {
      // Bookkeeping never interrupts the provider. The bare PID is recorded before the start-identity probe so a
      // controller crash during the probe still leaves a verifiable record; a missing identity keeps recovery conservative.
      try { input.onSpawn({ pid: child.pid, processStartedAt: null }); } catch { /* recorded as unverifiable */ }
      try { input.onSpawn({ pid: child.pid, processStartedAt: currentProcessStartIdentity(child.pid) }); } catch { /* keeps the bare PID record */ }
    }
    const settlement = (): WorkflowProcessSettlement => ({
      parentExitCode: parentExit ? parentExit.code : null,
      parentExitSignal: parentExit ? parentExit.signal : null,
      outputComplete: streamClose,
      termination,
      directChild: !started ? 'not-started' : parentExit ? 'exited' : 'unconfirmed',
      descendants: !started ? 'not-started' : 'unverified',
    });
    const captureStdout = (chunk: Buffer) => {
      stdoutObservedBytes = Math.min(MAX_LOG_BYTES + 1, stdoutObservedBytes + chunk.length);
      stdout ??= Buffer.allocUnsafe(MAX_LOG_BYTES);
      if (!retainStdoutTail) {
        const keptBytes = Math.min(chunk.length, Math.max(0, MAX_LOG_BYTES - stdoutBytes));
        if (keptBytes) chunk.copy(stdout, stdoutBytes, 0, keptBytes);
        stdoutTruncated ||= keptBytes < chunk.length; stdoutBytes += keptBytes; return;
      }
      if (chunk.length >= MAX_LOG_BYTES) {
        chunk.copy(stdout, 0, chunk.length - MAX_LOG_BYTES);
        stdoutBytes = MAX_LOG_BYTES; stdoutOffset = 0;
      } else if (stdoutBytes < MAX_LOG_BYTES) {
        const beforeWrap = Math.min(chunk.length, MAX_LOG_BYTES - stdoutBytes);
        chunk.copy(stdout, stdoutBytes, 0, beforeWrap); stdoutBytes += beforeWrap;
        if (beforeWrap < chunk.length) {
          chunk.copy(stdout, 0, beforeWrap); stdoutBytes = MAX_LOG_BYTES; stdoutOffset = chunk.length - beforeWrap;
        }
      } else {
        const beforeWrap = Math.min(chunk.length, MAX_LOG_BYTES - stdoutOffset);
        chunk.copy(stdout, stdoutOffset, 0, beforeWrap);
        if (beforeWrap < chunk.length) chunk.copy(stdout, 0, beforeWrap);
        stdoutOffset = (stdoutOffset + chunk.length) % MAX_LOG_BYTES;
      }
      stdoutTruncated ||= stdoutObservedBytes > MAX_LOG_BYTES;
    };
    const filterThinkingProgress = input.collectUsage === true && input.provider !== undefined && input.provider !== 'codex';
    let streamJsonLine: Buffer | undefined;
    let streamJsonLineBytes = 0;
    let streamJsonPassthrough = false;
    const clearStreamJsonLine = () => { streamJsonLineBytes = 0; };
    const flushStreamJsonLine = () => {
      if (streamJsonLine && streamJsonLineBytes) captureStdout(streamJsonLine.subarray(0, streamJsonLineBytes));
      clearStreamJsonLine();
    };
    const thinkingProgressLine = () => {
      if (!streamJsonLine) return false;
      let event: unknown;
      try { event = JSON.parse(streamJsonLine.subarray(0, streamJsonLineBytes).toString('utf8').trim()); }
      catch { return false; }
      return event !== null && typeof event === 'object' && !Array.isArray(event)
        && (event as Record<string, unknown>).type === 'system'
        && (event as Record<string, unknown>).subtype === 'thinking_tokens';
    };
    const captureFilteredStdout = (chunk: Buffer) => {
      if (!filterThinkingProgress) { captureStdout(chunk); return; }
      if (stdoutTruncated && !retainStdoutTail) return;
      let offset = 0;
      while (offset < chunk.length) {
        const newline = chunk.indexOf(0x0a, offset);
        const end = newline < 0 ? chunk.length : newline + 1;
        const part = chunk.subarray(offset, end);
        if (streamJsonPassthrough) captureStdout(part);
        else if (streamJsonLineBytes + part.length > MAX_STREAM_JSON_LINE_BYTES) {
          flushStreamJsonLine(); captureStdout(part); streamJsonPassthrough = newline < 0;
        } else {
          streamJsonLine ??= Buffer.allocUnsafe(MAX_STREAM_JSON_LINE_BYTES);
          part.copy(streamJsonLine, streamJsonLineBytes); streamJsonLineBytes += part.length;
          if (newline >= 0) {
            if (thinkingProgressLine()) clearStreamJsonLine();
            else flushStreamJsonLine();
          }
        }
        if (stdoutTruncated && !retainStdoutTail) break;
        if (newline >= 0) streamJsonPassthrough = false;
        offset = end;
      }
    };
    const finish = (code: number | null) => {
      if (finished) return;
      finished = true;
      if (elapsedTimer) clearTimeout(elapsedTimer);
      if (reapTimer) clearTimeout(reapTimer);
      if (settlementTimer) clearTimeout(settlementTimer);
      process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
      // Partial and oversized records are ordinary provider output, never silently filtered.
      flushStreamJsonLine();
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
      const capturedStdout = () => {
        if (!stdout) return Buffer.alloc(0);
        const ordered = stdoutBytes < MAX_LOG_BYTES || stdoutOffset === 0 ? stdout.subarray(0, stdoutBytes)
          : Buffer.concat([stdout.subarray(stdoutOffset), stdout.subarray(0, stdoutOffset)]);
        if (!retainStdoutTail || !stdoutTruncated) return captured([ordered], stdoutTruncated);
        const marker = Buffer.from('[output truncated]\n');
        const firstRecordEnd = ordered.indexOf(0x0a);
        let tailSafe = firstRecordEnd < 0 ? '' : ordered.subarray(firstRecordEnd + 1).toString('utf8');
        if (!tailSafe.endsWith('\n')) {
          const lastLine = tailSafe.lastIndexOf('\n') + 1;
          const trailingRecord = tailSafe.slice(lastLine);
          if (/^\s*[\[{]/.test(trailingRecord)) {
            try { JSON.parse(trailingRecord); }
            catch { tailSafe = tailSafe.slice(0, lastLine); }
          }
        }
        for (const [key, value] of [...Object.entries(process.env), ...Object.entries(redactionEnvironment)]) {
          if (!/(?:key|token|secret|password|credential|authorization)/i.test(key) || !value || value.length < 4) continue;
          for (let length = Math.min(value.length - 1, tailSafe.length); length > 0; length--) {
            if (tailSafe.endsWith(value.slice(0, length))) { tailSafe = tailSafe.slice(0, -length); break; }
          }
        }
        let safeTail = Buffer.from(redactWorkflowText(tailSafe, false, redactionEnvironment));
        while (safeTail.length > MAX_LOG_BYTES - marker.length) {
          const newline = safeTail.indexOf(0x0a);
          safeTail = newline < 0 ? Buffer.alloc(0) : safeTail.subarray(newline + 1);
        }
        return Buffer.concat([marker, safeTail]);
      };
      resolve({ code, error, stdout: capturedStdout(),
        stderr: captured(stderr, stderrTruncated), stdoutTruncated,
        ...(noWall ? { settlement: settlement() } : {}) });
    };
    /** Wait out the shared grace before dropping this controller's stream handles. */
    const scheduleReap = () => {
      if (reapTimer) return;
      reapTimer = setTimeout(() => {
        child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy(); child.unref(); finish(null);
      }, SETTLEMENT_GRACE_MS);
    };
    const terminate = () => {
      // A stop is requested at most once. Null mode never signals an exited parent;
      // finite mode retains its existing inherited-group/tree termination path.
      if (termination !== 'not-requested') return;
      if (noWall && parentExit) { scheduleReap(); return; }
      termination = 'attempted';
      if (child.pid) {
        try {
          if (process.platform === 'win32') {
            const killed = spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 2000, shell: false });
            // A failed invocation is reported instead of being assumed to have cleaned up.
            if (killed.error || killed.status !== 0) termination = 'failed';
          } else process.kill(-child.pid, 'SIGKILL');
        } catch {
          termination = 'failed';
          try { child.kill('SIGKILL'); } catch { /* Settlement below reports the failed invocation. */ }
        }
      } else termination = 'failed';
      scheduleReap();
    };
    const interrupt = () => { error = 'interrupted'; terminate(); };
    process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
    const elapsedTimer = timeoutMs === null ? undefined : setTimeout(() => { error = 'timeout'; terminate(); }, timeoutMs);
    child.on('spawn', () => { started = true; });
    child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      started = true;
      parentExit ??= { code, signal };
      // Only the unbounded mode separates parent exit from stream close: bounded output keeps
      // flowing while the inherited pipes drain, and only a close inside the grace ends the run.
      if (!noWall) return;
      settlementTimer = setTimeout(() => {
        if (finished) return;
        error ??= 'output_incomplete';
        child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy(); child.unref(); finish(null);
      }, SETTLEMENT_GRACE_MS);
    });
    child.stdout.on('data', (chunk: Buffer) => {
      usage?.write(chunk);
      if (!error) {
        try { input.onStdout?.(chunk); }
        catch { error = 'protocol_failed'; terminate(); }
      }
      captureFilteredStdout(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const kept = chunk.subarray(0, Math.max(0, MAX_LOG_BYTES - stderrBytes));
      if (kept.length) stderr.push(kept);
      stderrTruncated ||= kept.length < chunk.length; stderrBytes += kept.length;
    });
    child.on('error', () => { error = 'launch_failed'; });
    child.stdin.on('error', () => { /* EPIPE is reflected in the exit status. */ });
    child.on('close', (code: number | null) => { streamClose = true; finish(code); });
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
  const parentExitedSuccessfully = result.settlement
    ? result.settlement.parentExitCode === 0 && result.settlement.parentExitSignal === null && result.settlement.directChild === 'exited'
    : result.code === 0;
  // A capture/settlement failure can make the workflow result unsafe without turning a clean
  // provider exit into a process_failed telemetry diagnosis.
  const telemetry = usage?.finish({ durationMs: performance.now() - startedAt, passed: parentExitedSuccessfully });
  if (telemetry && result.stdoutTruncated) {
    telemetry.diagnostics = [...new Set([...(telemetry.diagnostics ?? []), 'stdout_truncated'])].sort();
    if (telemetry.status === 'measured') telemetry.status = 'partial';
  }
  if (telemetry && result.settlement?.outputComplete === false) {
    telemetry.diagnostics = [...new Set([...(telemetry.diagnostics ?? []), 'output_incomplete'])].sort();
    if (telemetry.status === 'measured') telemetry.status = 'partial';
  }
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
  return { passed: result.code === 0 && !failure, ...(failure ? { error: failure } : {}), artifacts,
    parentExitedSuccessfully, stdoutTruncated: result.stdoutTruncated,
    ...(result.settlement ? { settlement: result.settlement } : {}), ...(telemetry ? { telemetry } : {}) };
}
