import { StringDecoder } from 'node:string_decoder';

export interface WorkflowIdentityEvidence {
  value: string;
  initEvents?: number;
  assistantEvents?: number;
  terminalEvents?: number;
  threadEvents?: number;
  terminalUsageBuckets?: number;
}

export interface WorkflowTerminalUsageEvidence {
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  observations: number;
}

export interface WorkflowTelemetryEvidence {
  version: 1;
  diagnosticLogComplete: boolean;
  eventStreamComplete: boolean;
  identityEvidenceComplete: boolean;
  identityConsistent: boolean;
  accountingEvidenceComplete: boolean;
  terminalEventCount: number;
  sessions: WorkflowIdentityEvidence[];
  models: WorkflowIdentityEvidence[];
  terminalUsageBuckets: WorkflowTerminalUsageEvidence[];
}

export interface WorkflowTelemetry {
  provider: 'glm' | 'mimo' | 'codex' | 'claude';
  durationMs: number;
  status: 'measured' | 'partial' | 'unknown';
  scope: 'all-models' | 'main-loop' | 'turn' | 'unknown';
  /** Total input, including cache reads and cache creation where the provider reports them. */
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  sessionId?: string;
  terminal?: 'success' | 'failure';
  diagnostics?: string[];
  /** Bounded provider metadata only; no transcript, error text, or raw event survives here. */
  evidence?: WorkflowTelemetryEvidence;
}

type Counters = Pick<WorkflowTelemetry, 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens'>;
type RecordValue = Record<string, unknown>;
const MAX_LINE_BYTES = 256 * 1024;
// Keep the summary small enough for the maximum 100-task, five-attempt workflow state.
const MAX_EVIDENCE_IDENTITIES = 8;
const MAX_TERMINAL_USAGE_BUCKETS = 8;
const MAX_TERMINAL_USAGE_INPUT_MODELS = 64;
const MAX_TASKS = 64;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,159}(?:\[[A-Za-z0-9._+-]+\])?$/;
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,159}$/;
const SENSITIVE_IDENTITY = /(?:key|token|secret|password|credential|authorization)/i;
const COUNTERS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const;
type IdentitySource = Exclude<keyof WorkflowIdentityEvidence, 'value'>;

export interface WorkflowUsageCollectorOptions {
  /** Returns false when an otherwise valid identifier matches a known private value. */
  retainIdentity?: (value: string) => boolean;
}

export interface WorkflowUsageOutcome {
  durationMs: number;
  passed: boolean;
  diagnosticLogComplete?: boolean;
  eventStreamComplete?: boolean;
}

function record(value: unknown): RecordValue | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : undefined;
}

/** Reads only provider metadata; neither transcripts nor raw error messages survive this boundary. */
export function createWorkflowUsageCollector(provider: WorkflowTelemetry['provider'], options: WorkflowUsageCollectorOptions = {}): {
  write(chunk: Buffer): void;
  finish(outcome: WorkflowUsageOutcome): WorkflowTelemetry;
} {
  const decoder = new StringDecoder('utf8');
  const diagnostics = new Set<string>();
  const sessions = new Map<string, WorkflowIdentityEvidence>();
  const models = new Map<string, WorkflowIdentityEvidence>();
  const terminalUsageBuckets = new Map<string, WorkflowTerminalUsageEvidence>();
  const tasks = new Map<string, { status: 'running' | 'completed' | 'failed'; sessionId: string; toolUseId?: string;
    notificationSeen: boolean; notificationConsumed: boolean }>();
  const pendingTaskNotifications: string[] = [];
  let line = ''; let lineBytes = 0; let discarding = false;
  let counters: Counters = {};
  let scope: WorkflowTelemetry['scope'] = 'unknown';
  let terminal: WorkflowTelemetry['terminal'];
  let terminalSignature: string | undefined;
  let conflictingTerminal = false;
  let failedCodexTurn = false;
  let sessionId: string | undefined;
  let invalidSession = false;
  let primaryModel: string | undefined;
  let identityEvidenceValid = true;
  let identityConsistent = true;
  let accountingEvidenceValid = true;
  let metadataEvidenceComplete = true;
  let terminalEventCount = 0;
  let mainResultCount = 0;
  let notificationResultCount = 0;
  let taskEvidenceValid = true;
  let missingInitModel = false;
  let initSessionObserved = false;
  let terminalSessionObserved = false;

  function increment(target: { [key: string]: unknown }, key: string, diagnostic: string): void {
    const current = typeof target[key] === 'number' ? target[key] as number : 0;
    if (current === Number.MAX_SAFE_INTEGER) {
      diagnostics.add(diagnostic); metadataEvidenceComplete = false; return;
    }
    target[key] = current + 1;
  }

  function retain(value: string): boolean {
    try { return !SENSITIVE_IDENTITY.test(value) && (options.retainIdentity?.(value) ?? true); }
    catch { return false; }
  }

  function observe(map: Map<string, WorkflowIdentityEvidence>, value: string, source: IdentitySource,
    overflowDiagnostic: string): boolean {
    let evidence = map.get(value);
    if (!evidence) {
      if (map.size >= MAX_EVIDENCE_IDENTITIES) {
        diagnostics.add(overflowDiagnostic); identityEvidenceValid = false; identityConsistent = false; return false;
      }
      evidence = { value }; map.set(value, evidence);
    }
    increment(evidence as unknown as { [key: string]: unknown }, source, 'identity_observation_overflow');
    return true;
  }

  function session(value: unknown, source?: IdentitySource): string | undefined {
    if (value === undefined || value === null) {
      identityEvidenceValid = false; diagnostics.add('missing_session_id'); return undefined;
    }
    if (typeof value !== 'string' || !UUID.test(value)) {
      invalidSession = true; identityEvidenceValid = false; identityConsistent = false;
      diagnostics.add('session_identity_invalid'); return undefined;
    }
    const normalized = value.toLowerCase();
    if (!retain(normalized)) {
      invalidSession = true; identityEvidenceValid = false; identityConsistent = false;
      diagnostics.add('session_identity_invalid'); diagnostics.add('session_identity_redacted'); return undefined;
    }
    if (sessionId && sessionId !== normalized) {
      invalidSession = true; identityConsistent = false; diagnostics.add('session_identity_conflict');
    } else sessionId = normalized;
    if (source && observe(sessions, normalized, source, 'session_identity_evidence_overflow')) {
      if (source === 'initEvents') initSessionObserved = true;
      if (source === 'terminalEvents') terminalSessionObserved = true;
    }
    return normalized;
  }

  function invalidateTask(diagnostic: string): void {
    taskEvidenceValid = false; identityEvidenceValid = false; accountingEvidenceValid = false;
    diagnostics.add(diagnostic);
  }

  function taskIdentity(value: unknown): string | undefined {
    if (typeof value !== 'string' || !TASK_ID.test(value)) {
      invalidateTask('task_identity_invalid'); return undefined;
    }
    return value;
  }

  function optionalTaskReference(value: unknown, diagnostic: string): string | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || !TASK_ID.test(value)) {
      invalidateTask(diagnostic); return undefined;
    }
    return value;
  }

  function taskStarted(event: RecordValue): void {
    const expectedSessionId = sessionId;
    const taskSessionId = session(event.session_id);
    const id = taskIdentity(event.task_id);
    const toolUseId = optionalTaskReference(event.tool_use_id, 'task_tool_use_identity_invalid');
    if (!taskSessionId) invalidateTask('task_session_invalid');
    else if (expectedSessionId && taskSessionId !== expectedSessionId) invalidateTask('task_session_conflict');
    if (!id || !taskSessionId || event.tool_use_id !== undefined && !toolUseId) return;
    if (tasks.has(id)) { invalidateTask('duplicate_task_started'); return; }
    if (tasks.size >= MAX_TASKS) { invalidateTask('task_evidence_overflow'); return; }
    tasks.set(id, { status: 'running', sessionId: taskSessionId, ...(toolUseId ? { toolUseId } : {}),
      notificationSeen: false, notificationConsumed: false });
  }

  function taskUpdated(event: RecordValue): void {
    const id = taskIdentity(event.task_id);
    if (!id) return;
    const task = tasks.get(id);
    if (!task) { invalidateTask('unknown_task_update'); return; }
    if (event.session_id !== undefined && session(event.session_id) !== task.sessionId) {
      invalidateTask('task_session_conflict'); return;
    }
    const patch = event.patch === undefined ? undefined : record(event.patch);
    if (event.patch !== undefined && !patch) { invalidateTask('invalid_task_update'); return; }
    const patchStatus = patch?.status;
    const topLevelStatus = event.status;
    if (patchStatus !== undefined && topLevelStatus !== undefined && patchStatus !== topLevelStatus) {
      invalidateTask('task_status_conflict'); return;
    }
    const status = patchStatus ?? topLevelStatus;
    if (status === undefined) return;
    if (!['pending', 'running', 'paused', 'completed', 'failed', 'stopped', 'killed'].includes(String(status))) {
      invalidateTask('invalid_task_status'); return;
    }
    if (status === 'completed') {
      if (task.status === 'failed') invalidateTask('task_status_conflict');
      else task.status = 'completed';
    } else if (status === 'failed' || status === 'stopped' || status === 'killed') {
      task.status = 'failed'; invalidateTask('task_failed');
    } else if (task.status !== 'running') {
      invalidateTask('task_status_conflict');
    }
  }

  function taskNotification(event: RecordValue): void {
    const id = taskIdentity(event.task_id);
    if (!id) return;
    const task = tasks.get(id);
    if (!task) { invalidateTask('unknown_task_notification'); return; }
    const toolUseId = optionalTaskReference(event.tool_use_id, 'task_tool_use_identity_invalid');
    if (event.tool_use_id !== undefined && !toolUseId) return;
    if (toolUseId && task.toolUseId && toolUseId !== task.toolUseId) {
      invalidateTask('task_tool_use_identity_conflict'); return;
    }
    if (session(event.session_id) !== task.sessionId) {
      invalidateTask('task_session_conflict'); return;
    }
    if (task.notificationSeen) { invalidateTask('duplicate_task_notification'); return; }
    task.notificationSeen = true;
    if (event.status !== 'completed') {
      task.status = 'failed'; invalidateTask(event.status === 'failed' || event.status === 'stopped'
        ? 'task_notification_failed' : 'invalid_task_status');
      return;
    }
    if (task.status === 'failed') { invalidateTask('task_status_conflict'); return; }
    task.status = 'completed'; pendingTaskNotifications.push(id);
  }

  function classifyClaudeResult(event: RecordValue): boolean {
    const origin = event.origin;
    const parsedOrigin = record(origin);
    if (origin === undefined || origin === null || parsedOrigin?.kind === 'human') {
      mainResultCount++;
      if (mainResultCount > 1) invalidateTask('duplicate_terminal_events');
      return false;
    }
    if (!parsedOrigin || parsedOrigin.kind !== 'task-notification'
      || parsedOrigin.subkind !== undefined || parsedOrigin.fireReason !== undefined) {
      invalidateTask('unknown_result_origin'); return false;
    }
    if (mainResultCount !== 1) {
      invalidateTask('missing_main_result'); return false;
    }
    if (pendingTaskNotifications.length !== 1) {
      invalidateTask(pendingTaskNotifications.length === 0
        ? 'unresolved_task_notification_result' : 'ambiguous_task_notification_result');
      return false;
    }
    const id = pendingTaskNotifications[0]!;
    const task = tasks.get(id)!;
    const originTaskId = optionalTaskReference(parsedOrigin.task_id, 'task_identity_invalid');
    if (parsedOrigin.task_id !== undefined && !originTaskId) return false;
    if (originTaskId && originTaskId !== id) {
      invalidateTask('task_notification_origin_mismatch'); return false;
    }
    if (session(event.session_id) !== task.sessionId) {
      invalidateTask('task_session_conflict'); return false;
    }
    pendingTaskNotifications.shift();
    task.notificationConsumed = true; notificationResultCount++;
    return true;
  }

  function model(value: unknown, source: IdentitySource, primary = false): string | undefined {
    if (value === undefined || value === null) {
      identityEvidenceValid = false; diagnostics.add('missing_model_id'); return undefined;
    }
    if (typeof value !== 'string' || value.length > 160 || !MODEL_ID.test(value)) {
      identityEvidenceValid = false; identityConsistent = false; diagnostics.add('model_identity_invalid'); return undefined;
    }
    if (!retain(value)) {
      identityEvidenceValid = false; identityConsistent = false; diagnostics.add('model_identity_redacted'); return undefined;
    }
    if (primary) {
      if (primaryModel && primaryModel !== value) {
        identityConsistent = false; diagnostics.add('model_identity_conflict');
      } else primaryModel = value;
    }
    return observe(models, value, source, 'model_identity_evidence_overflow') ? value : undefined;
  }

  function count(value: unknown): number | undefined {
    if (value === undefined) { accountingEvidenceValid = false; diagnostics.add('missing_usage_fields'); return undefined; }
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      accountingEvidenceValid = false; diagnostics.add('invalid_usage_counts'); return undefined;
    }
    return value;
  }

  function sum(values: (number | undefined)[]): number | undefined {
    if (values.some(value => value === undefined)) return undefined;
    const total = values.reduce<number>((result, value) => result + (value ?? 0), 0);
    if (!Number.isSafeInteger(total)) { accountingEvidenceValid = false; diagnostics.add('usage_overflow'); return undefined; }
    return total;
  }

  function claudeCounts(usage: RecordValue, camelCase: boolean): { counters: Counters; bucket: Omit<WorkflowTerminalUsageEvidence, 'model' | 'observations'> } {
    const fresh = count(usage[camelCase ? 'inputTokens' : 'input_tokens']);
    const read = count(usage[camelCase ? 'cacheReadInputTokens' : 'cache_read_input_tokens']);
    const write = count(usage[camelCase ? 'cacheCreationInputTokens' : 'cache_creation_input_tokens']);
    const output = count(usage[camelCase ? 'outputTokens' : 'output_tokens']);
    return { counters: { inputTokens: sum([fresh, read, write]), outputTokens: output,
      cacheReadTokens: read, cacheWriteTokens: write }, bucket: {
      ...(fresh === undefined ? {} : { inputTokens: fresh }), ...(output === undefined ? {} : { outputTokens: output }),
      ...(read === undefined ? {} : { cacheReadInputTokens: read }),
      ...(write === undefined ? {} : { cacheCreationInputTokens: write }),
    } };
  }

  function terminalBucket(modelId: string, bucket: Omit<WorkflowTerminalUsageEvidence, 'model' | 'observations'>): void {
    const signature = JSON.stringify([modelId, bucket.inputTokens ?? null, bucket.outputTokens ?? null,
      bucket.cacheReadInputTokens ?? null, bucket.cacheCreationInputTokens ?? null]);
    let evidence = terminalUsageBuckets.get(signature);
    if (!evidence) {
      if (terminalUsageBuckets.size >= MAX_TERMINAL_USAGE_BUCKETS) {
        diagnostics.add('terminal_usage_evidence_overflow'); accountingEvidenceValid = false; return;
      }
      evidence = { model: modelId, ...bucket, observations: 0 }; terminalUsageBuckets.set(signature, evidence);
    }
    increment(evidence as unknown as { [key: string]: unknown }, 'observations', 'terminal_usage_observation_overflow');
  }

  function claudeUsage(event: RecordValue): { counters: Counters; scope: WorkflowTelemetry['scope']; signature: string } {
    if (event.modelUsage !== undefined) {
      const models = record(event.modelUsage);
      const entries = models && Object.entries(models);
      if (!entries || entries.length === 0 || entries.length > MAX_TERMINAL_USAGE_INPUT_MODELS || entries.some(([, value]) => !record(value))) {
        identityEvidenceValid = false; accountingEvidenceValid = false;
        diagnostics.add('invalid_model_usage'); return { counters: {}, scope: 'unknown', signature: 'invalid' };
      }
      const signatures: string[] = [];
      const modelCounts = entries.map(([modelId, value]) => {
        const parsed = claudeCounts(record(value)!, true);
        const safeModel = model(modelId, 'terminalUsageBuckets');
        if (safeModel) {
          terminalBucket(safeModel, parsed.bucket);
          signatures.push(JSON.stringify([safeModel, parsed.bucket]));
        } else {
          accountingEvidenceValid = false; signatures.push(JSON.stringify([null, parsed.bucket]));
        }
        return parsed.counters;
      });
      return { counters: Object.fromEntries(COUNTERS.map(key => [key, sum(modelCounts.map(value => value[key]))])),
        scope: 'all-models', signature: JSON.stringify(signatures.sort()) };
    }
    const usage = record(event.usage);
    if (!usage) {
      accountingEvidenceValid = false; diagnostics.add('missing_usage'); return { counters: {}, scope: 'unknown', signature: 'missing' };
    }
    accountingEvidenceValid = false; diagnostics.add('main_loop_usage_only');
    const parsed = claudeCounts(usage, false);
    return { counters: parsed.counters, scope: 'main-loop', signature: JSON.stringify(parsed.bucket) };
  }

  function observeTerminal(allowAdditional = false): void {
    if (terminalEventCount === Number.MAX_SAFE_INTEGER) {
      accountingEvidenceValid = false; metadataEvidenceComplete = false; diagnostics.add('terminal_event_overflow'); return;
    }
    terminalEventCount++;
    if (terminalEventCount > 1 && !allowAdditional) {
      accountingEvidenceValid = false; diagnostics.add('duplicate_terminal_events');
    }
  }

  function complete(event: RecordValue, nextTerminal: 'success' | 'failure', nextCounters: Counters,
    nextScope: WorkflowTelemetry['scope'], usageSignature = '', allowAdditional = false): void {
    observeTerminal(allowAdditional);
    const signature = JSON.stringify({ terminal: nextTerminal, counters: nextCounters, scope: nextScope, usageSignature });
    if (terminalSignature && terminalSignature !== signature) {
      conflictingTerminal = true; accountingEvidenceValid = false; diagnostics.add('conflicting_terminal_events');
    } else if (!terminalSignature) {
      terminalSignature = signature; counters = nextCounters; scope = nextScope;
    }
    if (terminal !== 'failure') terminal = nextTerminal;
    if (provider !== 'codex') session(event.session_id, 'terminalEvents');
  }

  function consume(text: string): void {
    if (!text.trim()) return;
    let event: RecordValue | undefined;
    try { event = record(JSON.parse(text)); }
    catch {
      metadataEvidenceComplete = false; identityEvidenceValid = false; accountingEvidenceValid = false;
      diagnostics.add('malformed_event'); return;
    }
    if (!event) {
      metadataEvidenceComplete = false; identityEvidenceValid = false; accountingEvidenceValid = false;
      diagnostics.add('malformed_event'); return;
    }
    if (provider !== 'codex') {
      if (event.type === 'system' && event.subtype === 'init') {
        session(event.session_id, 'initEvents');
        if (event.model === undefined) missingInitModel = true;
        else model(event.model, 'initEvents', true);
      } else if (event.type === 'system' && event.subtype === 'task_started') {
        taskStarted(event);
      } else if (event.type === 'system' && event.subtype === 'task_updated') {
        taskUpdated(event);
      } else if (event.type === 'system' && event.subtype === 'task_notification') {
        taskNotification(event);
      } else if (event.type === 'assistant') {
        session(event.session_id, 'assistantEvents');
        const message = record(event.message);
        const assistantModel = message?.model ?? event.model;
        model(assistantModel, 'assistantEvents', true);
      }
      if (event.type !== 'result') return;
      const allowAdditional = classifyClaudeResult(event);
      const usage = claudeUsage(event);
      complete(event, event.subtype === 'success' && event.is_error !== true ? 'success' : 'failure',
        usage.counters, usage.scope, usage.signature, allowAdditional);
    } else {
      if (event.type === 'thread.started') session(event.thread_id, 'threadEvents');
      if (event.type === 'turn.completed') {
        const usage = record(event.usage);
        let next: Counters = {};
        if (usage) {
          next = { inputTokens: count(usage.input_tokens), outputTokens: count(usage.output_tokens), cacheReadTokens: count(usage.cached_input_tokens) };
          // Newer Codex versions report cache creation separately; it is already part of input.
          if (usage.cache_write_input_tokens !== undefined) next.cacheWriteTokens = count(usage.cache_write_input_tokens);
          const invalidSubsets = (['cacheReadTokens', 'cacheWriteTokens'] as const).filter(key =>
            next.inputTokens !== undefined && next[key] !== undefined && next[key]! > next.inputTokens);
          if (invalidSubsets.length) {
            accountingEvidenceValid = false; diagnostics.add('invalid_cache_subset'); delete next.inputTokens;
            for (const key of invalidSubsets) delete next[key];
          }
        } else { accountingEvidenceValid = false; diagnostics.add('missing_usage'); }
        // Codex also emits top-level errors for transient retries, without the will_retry flag.
        // Only a later first completed turn can establish recovery; a failed turn stays failed.
        if (terminal === 'failure' && !failedCodexTurn && !terminalSignature) {
          terminal = undefined; diagnostics.add('recovered_provider_error');
        }
        complete(event, 'success', next, usage ? 'turn' : 'unknown');
      } else if (event.type === 'turn.failed' || event.type === 'error') {
        // Neither event carries authoritative usage. Errors after completion remain failures.
        if (event.type === 'turn.failed') { failedCodexTurn = true; observeTerminal(); }
        terminal = 'failure';
      }
    }
  }

  function append(text: string): void {
    let start = 0;
    while (start < text.length) {
      const newline = text.indexOf('\n', start);
      const end = newline < 0 ? text.length : newline;
      if (!discarding) {
        const part = text.slice(start, end);
        lineBytes += Buffer.byteLength(part, 'utf8');
        if (lineBytes > MAX_LINE_BYTES) {
          line = ''; discarding = true; metadataEvidenceComplete = false;
          identityEvidenceValid = false; accountingEvidenceValid = false; diagnostics.add('oversized_event');
        } else line += part;
      }
      if (newline < 0) return;
      if (!discarding) consume(line);
      line = ''; lineBytes = 0; discarding = false; start = newline + 1;
    }
  }

  return {
    write(chunk) { append(decoder.write(chunk)); },
    finish(outcome) {
      append(decoder.end());
      if (line && !discarding) consume(line);
      line = '';
      if (!terminal) diagnostics.add('missing_terminal_event');
      if (!sessionId) diagnostics.add('missing_session_id');
      if (!outcome.passed) diagnostics.add('process_failed');
      if (provider !== 'codex') {
        if (terminalEventCount > 0 && mainResultCount === 0) invalidateTask('missing_main_result');
        for (const task of tasks.values()) {
          if (task.status !== 'completed' || task.notificationSeen && !task.notificationConsumed) {
            invalidateTask('unresolved_task');
          }
        }
      }
      if (conflictingTerminal) { counters = {}; scope = 'unknown'; }
      const failed = !outcome.passed || terminal !== 'success';
      // Providers may emit zero-filled error usage after a crash. That is not evidence of free work.
      if (failed && COUNTERS.every(key => counters[key] === undefined || counters[key] === 0)) {
        counters = {}; scope = 'unknown'; diagnostics.add('unavailable_failure_usage');
      }
      const known = COUNTERS.some(key => counters[key] !== undefined);
      const required = provider !== 'codex' ? COUNTERS : COUNTERS.slice(0, 3);
      const completeCounts = required.every(key => counters[key] !== undefined);
      const eventStreamComplete = outcome.eventStreamComplete ?? true;
      if (!eventStreamComplete) diagnostics.add('incomplete_event_stream');
      if (provider !== 'codex' && terminalEventCount > 1 && taskEvidenceValid) {
        if (!initSessionObserved) invalidateTask('missing_init_event');
        else if (missingInitModel) invalidateTask('missing_model_id');
      }
      const terminalFramingComplete = provider === 'codex' ? terminalEventCount === 1
        : taskEvidenceValid && mainResultCount === 1 && terminalEventCount === 1 + notificationResultCount
          && pendingTaskNotifications.length === 0
          && (terminalEventCount === 1 || initSessionObserved && identityEvidenceValid && identityConsistent);
      const evidence: WorkflowTelemetryEvidence = {
        version: 1,
        diagnosticLogComplete: outcome.diagnosticLogComplete ?? true,
        eventStreamComplete,
        identityEvidenceComplete: eventStreamComplete && metadataEvidenceComplete && identityEvidenceValid
          && terminalFramingComplete && sessions.size > 0
          && (provider === 'codex' || initSessionObserved && terminalSessionObserved && models.size > 0),
        identityConsistent,
        accountingEvidenceComplete: eventStreamComplete && metadataEvidenceComplete && accountingEvidenceValid
          && outcome.passed && terminal === 'success' && terminalFramingComplete && !conflictingTerminal
          && completeCounts && scope !== 'main-loop',
        terminalEventCount,
        sessions: [...sessions.values()].sort((a, b) => a.value.localeCompare(b.value)),
        models: [...models.values()].sort((a, b) => a.value.localeCompare(b.value)),
        terminalUsageBuckets: [...terminalUsageBuckets.values()].sort((a, b) =>
          a.model.localeCompare(b.model) || JSON.stringify(a).localeCompare(JSON.stringify(b))),
      };
      return { provider, durationMs: Math.max(0, Math.round(outcome.durationMs)),
        status: !known ? 'unknown' : !failed && completeCounts && scope !== 'main-loop' && diagnostics.size === 0 ? 'measured' : 'partial',
        scope, ...counters, ...(sessionId && !invalidSession ? { sessionId } : {}), ...(terminal ? { terminal } : {}),
        ...(diagnostics.size ? { diagnostics: [...diagnostics].sort() } : {}), evidence };
    },
  };
}
