import { StringDecoder } from 'node:string_decoder';

export interface WorkflowTelemetry {
  provider: 'glm' | 'codex';
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
}

type Counters = Pick<WorkflowTelemetry, 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens'>;
type RecordValue = Record<string, unknown>;
const MAX_LINE_BYTES = 256 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COUNTERS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const;

function record(value: unknown): RecordValue | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : undefined;
}

/** Reads only provider metadata; neither transcripts nor raw error messages survive this boundary. */
export function createWorkflowUsageCollector(provider: WorkflowTelemetry['provider']): {
  write(chunk: Buffer): void;
  finish(outcome: { durationMs: number; passed: boolean }): WorkflowTelemetry;
} {
  const decoder = new StringDecoder('utf8');
  const diagnostics = new Set<string>();
  let line = ''; let lineBytes = 0; let discarding = false;
  let counters: Counters = {};
  let scope: WorkflowTelemetry['scope'] = 'unknown';
  let terminal: WorkflowTelemetry['terminal'];
  let terminalSignature: string | undefined;
  let conflictingTerminal = false;
  let failedCodexTurn = false;
  let sessionId: string | undefined;
  let invalidSession = false;

  function session(value: unknown): void {
    if (value === undefined || value === null) { diagnostics.add('missing_session_id'); return; }
    if (typeof value !== 'string' || !UUID.test(value)) {
      invalidSession = true; diagnostics.add('session_identity_invalid'); return;
    }
    const normalized = value.toLowerCase();
    if (sessionId && sessionId !== normalized) {
      invalidSession = true; diagnostics.add('session_identity_conflict');
    } else sessionId = normalized;
  }

  function count(value: unknown): number | undefined {
    if (value === undefined) { diagnostics.add('missing_usage_fields'); return undefined; }
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      diagnostics.add('invalid_usage_counts'); return undefined;
    }
    return value;
  }

  function sum(values: (number | undefined)[]): number | undefined {
    if (values.some(value => value === undefined)) return undefined;
    const total = values.reduce<number>((result, value) => result + (value ?? 0), 0);
    if (!Number.isSafeInteger(total)) { diagnostics.add('usage_overflow'); return undefined; }
    return total;
  }

  function claudeCounts(usage: RecordValue, camelCase: boolean): Counters {
    const fresh = count(usage[camelCase ? 'inputTokens' : 'input_tokens']);
    const read = count(usage[camelCase ? 'cacheReadInputTokens' : 'cache_read_input_tokens']);
    const write = count(usage[camelCase ? 'cacheCreationInputTokens' : 'cache_creation_input_tokens']);
    return { inputTokens: sum([fresh, read, write]), outputTokens: count(usage[camelCase ? 'outputTokens' : 'output_tokens']),
      cacheReadTokens: read, cacheWriteTokens: write };
  }

  function claudeUsage(event: RecordValue): { counters: Counters; scope: WorkflowTelemetry['scope'] } {
    if (event.modelUsage !== undefined) {
      const models = record(event.modelUsage);
      const values = models && Object.values(models);
      if (!values || values.length === 0 || values.length > 64 || values.some(value => !record(value))) {
        diagnostics.add('invalid_model_usage'); return { counters: {}, scope: 'unknown' };
      }
      const modelCounts = values.map(value => claudeCounts(record(value)!, true));
      return { counters: Object.fromEntries(COUNTERS.map(key => [key, sum(modelCounts.map(value => value[key]))])), scope: 'all-models' };
    }
    const usage = record(event.usage);
    if (!usage) { diagnostics.add('missing_usage'); return { counters: {}, scope: 'unknown' }; }
    diagnostics.add('main_loop_usage_only');
    return { counters: claudeCounts(usage, false), scope: 'main-loop' };
  }

  function complete(event: RecordValue, nextTerminal: 'success' | 'failure', nextCounters: Counters, nextScope: WorkflowTelemetry['scope']): void {
    const signature = JSON.stringify({ terminal: nextTerminal, counters: nextCounters, scope: nextScope });
    if (terminalSignature && terminalSignature !== signature) {
      conflictingTerminal = true; diagnostics.add('conflicting_terminal_events');
    } else if (!terminalSignature) {
      terminalSignature = signature; counters = nextCounters; scope = nextScope;
    }
    if (terminal !== 'failure') terminal = nextTerminal;
    if (provider === 'glm' && event.session_id !== undefined) session(event.session_id);
  }

  function consume(text: string): void {
    if (!text.trim()) return;
    let event: RecordValue | undefined;
    try { event = record(JSON.parse(text)); }
    catch { diagnostics.add('malformed_event'); return; }
    if (!event) { diagnostics.add('malformed_event'); return; }
    if (provider === 'glm') {
      if (event.type === 'system' && event.subtype === 'init') session(event.session_id);
      if (event.type !== 'result') return;
      const usage = claudeUsage(event);
      complete(event, event.subtype === 'success' && event.is_error !== true ? 'success' : 'failure', usage.counters, usage.scope);
    } else {
      if (event.type === 'thread.started') session(event.thread_id);
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
            diagnostics.add('invalid_cache_subset'); delete next.inputTokens;
            for (const key of invalidSubsets) delete next[key];
          }
        } else diagnostics.add('missing_usage');
        // Codex also emits top-level errors for transient retries, without the will_retry flag.
        // Only a later first completed turn can establish recovery; a failed turn stays failed.
        if (terminal === 'failure' && !failedCodexTurn && !terminalSignature) {
          terminal = undefined; diagnostics.add('recovered_provider_error');
        }
        complete(event, 'success', next, usage ? 'turn' : 'unknown');
      } else if (event.type === 'turn.failed' || event.type === 'error') {
        // Neither event carries authoritative usage. Errors after completion remain failures.
        if (event.type === 'turn.failed') failedCodexTurn = true;
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
          line = ''; discarding = true; diagnostics.add('oversized_event');
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
      const required = provider === 'glm' ? COUNTERS : COUNTERS.slice(0, 3);
      const completeCounts = required.every(key => counters[key] !== undefined);
      return { provider, durationMs: Math.max(0, Math.round(outcome.durationMs)),
        status: !known ? 'unknown' : !failed && completeCounts && scope !== 'main-loop' && diagnostics.size === 0 ? 'measured' : 'partial',
        scope, ...counters, ...(sessionId && !invalidSession ? { sessionId } : {}), ...(terminal ? { terminal } : {}),
        ...(diagnostics.size ? { diagnostics: [...diagnostics].sort() } : {}) };
    },
  };
}
