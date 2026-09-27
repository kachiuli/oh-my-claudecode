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
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,159}(?:\[[A-Za-z0-9._+-]+\])?$/;
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

  function session(value: unknown, source: IdentitySource): void {
    if (value === undefined || value === null) {
      identityEvidenceValid = false; diagnostics.add('missing_session_id'); return;
    }
    if (typeof value !== 'string' || !UUID.test(value)) {
      invalidSession = true; identityEvidenceValid = false; identityConsistent = false;
      diagnostics.add('session_identity_invalid'); return;
    }
    const normalized = value.toLowerCase();
    if (!retain(normalized)) {
      invalidSession = true; identityEvidenceValid = false; identityConsistent = false;
      diagnostics.add('session_identity_invalid'); diagnostics.add('session_identity_redacted'); return;
    }
    if (sessionId && sessionId !== normalized) {
      invalidSession = true; identityConsistent = false; diagnostics.add('session_identity_conflict');
    } else sessionId = normalized;
    if (observe(sessions, normalized, source, 'session_identity_evidence_overflow')) {
      if (source === 'initEvents') initSessionObserved = true;
      if (source === 'terminalEvents') terminalSessionObserved = true;
    }
  }

  function model(value: unknown, source: IdentitySource, primary = false): string | undefined {
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

  function observeTerminal(): void {
    if (terminalEventCount === Number.MAX_SAFE_INTEGER) {
      accountingEvidenceValid = false; metadataEvidenceComplete = false; diagnostics.add('terminal_event_overflow'); return;
    }
    terminalEventCount++;
    if (terminalEventCount > 1) {
      accountingEvidenceValid = false; diagnostics.add('duplicate_terminal_events');
    }
  }

  function complete(event: RecordValue, nextTerminal: 'success' | 'failure', nextCounters: Counters,
    nextScope: WorkflowTelemetry['scope'], usageSignature = ''): void {
    observeTerminal();
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
        if (event.model !== undefined) model(event.model, 'initEvents', true);
      } else if (event.type === 'assistant') {
        if (event.session_id !== undefined) session(event.session_id, 'assistantEvents');
        const message = record(event.message);
        const assistantModel = message?.model ?? event.model;
        if (assistantModel !== undefined) model(assistantModel, 'assistantEvents', true);
      }
      if (event.type !== 'result') return;
      const usage = claudeUsage(event);
      complete(event, event.subtype === 'success' && event.is_error !== true ? 'success' : 'failure', usage.counters, usage.scope, usage.signature);
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
      const evidence: WorkflowTelemetryEvidence = {
        version: 1,
        diagnosticLogComplete: outcome.diagnosticLogComplete ?? true,
        eventStreamComplete,
        identityEvidenceComplete: eventStreamComplete && metadataEvidenceComplete && identityEvidenceValid
          && terminalEventCount === 1 && sessions.size > 0
          && (provider === 'codex' || initSessionObserved && terminalSessionObserved && models.size > 0),
        identityConsistent,
        accountingEvidenceComplete: eventStreamComplete && metadataEvidenceComplete && accountingEvidenceValid
          && outcome.passed && terminal === 'success' && terminalEventCount === 1 && !conflictingTerminal
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
