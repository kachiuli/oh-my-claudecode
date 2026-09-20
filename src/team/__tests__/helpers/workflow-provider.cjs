/* global require, process, setTimeout */
/* eslint-disable @typescript-eslint/no-require-imports -- Standalone CommonJS fake CLI, launched by Node. */
/* Credential-free CLI fixture: intentionally a real process using real Git. */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const configuration = JSON.parse(fs.readFileSync(process.env.OMC_WORKFLOW_TEST_CONFIG, 'utf8'));
const request = JSON.parse(fs.readFileSync(0, 'utf8'));
const git = (...args) => execFileSync('git', args, {
  cwd: process.cwd(), encoding: 'utf8', stdio: 'pipe', windowsHide: true,
}).trim();
const role = request.kind === 'review' ? 'codex' : 'glm';
const taskId = request.task?.id ?? 'review';
const behavior = configuration.tasks?.[taskId] ?? {};
const structured = role === 'glm' ? process.argv.includes('stream-json') : process.argv.includes('--json');
const sessionFlag = process.argv.includes('--resume') ? '--resume' : '--session-id';
const sessionId = behavior.sessionId ?? process.argv[process.argv.indexOf(sessionFlag) + 1];
function streamEvent(value) {
  if (structured) process.stdout.write(JSON.stringify(value) + '\n');
}
function emitUsage(failed = false) {
  if (behavior.omitUsage) {
    streamEvent(role === 'codex' ? { type: 'turn.completed' }
      : { type: 'result', subtype: failed ? 'error_during_execution' : 'success', is_error: failed,
        ...(behavior.omitSession ? {} : { session_id: sessionId }) });
    return;
  }
  if (role === 'codex') {
    streamEvent({ type: 'turn.completed', usage: { input_tokens: 150, cached_input_tokens: 100, output_tokens: 25 } });
  } else {
    streamEvent({ type: 'result', subtype: failed ? 'error_during_execution' : 'success', is_error: failed,
      ...(behavior.omitSession ? {} : { session_id: sessionId }),
      usage: { input_tokens: 120, output_tokens: 30, cache_read_input_tokens: 80, cache_creation_input_tokens: 20 },
      modelUsage: { 'glm-test': { inputTokens: 120, outputTokens: 30, cacheReadInputTokens: 80, cacheCreationInputTokens: 20, costUSD: 0.004 } },
      total_cost_usd: 0.004,
    });
  }
}
function event(event) {
  fs.appendFileSync(configuration.eventsPath, JSON.stringify({
    role, event, taskId, cwd: process.cwd(), branch: git('branch', '--show-current'),
    time: Date.now(), args: process.argv.slice(2), prompt: JSON.stringify(request),
  }) + '\n');
}

(async () => {
  event('start');
  if (!behavior.omitSession) {
    streamEvent(role === 'glm' ? { type: 'system', subtype: 'init', session_id: sessionId }
      : { type: 'thread.started', thread_id: '8ce7a8a3-f8f4-4132-b701-19d1ef10271a' });
  }
  // Stop after the CLI has established a session, before it touches the worktree.
  if (behavior.pauseBeforeWork) await new Promise(resolve => setTimeout(resolve, 30000));
  if (behavior.beforeWorkFailure) {
    emitUsage(true);
    event('end');
    process.exitCode = 17;
    return;
  }
  if (role === 'glm' && configuration.barrierCount) {
    const deadline = Date.now() + 10000;
    while (fs.readFileSync(configuration.eventsPath, 'utf8').split('\n').filter(line => line && JSON.parse(line).event === 'start').length < configuration.barrierCount) {
      if (Date.now() > deadline) throw new Error('Requested workers did not launch concurrently.');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  // A wall-less controller can see this direct child exit while an inherited pipe stays open in a
  // descendant; the run settles as output_incomplete instead of inventing a successful completion.
  if (behavior.outputIncomplete) {
    const { spawn } = require('node:child_process');
    spawn(process.execPath, ['-e', 'setTimeout(() => {}, 3000)'], {
      stdio: ['ignore', 'inherit', 'inherit'], detached: true, windowsHide: true, cwd: require('node:os').tmpdir(),
    }).unref();
    event('end');
    process.exit(0);
  }
  await new Promise(resolve => setTimeout(resolve, behavior.delayMs ?? configuration.delayMs ?? 0));
  if (behavior.resultFailure) {
    const outputIndex = process.argv.indexOf('--output-last-message');
    const resultFile = role === 'codex' ? process.argv[outputIndex + 1] : request.resultFile;
    const secret = process.env.OMC_FIXTURE_API_TOKEN;
    const metadata = behavior.resultFormat === 'invalid' ? `invalid JSON ${secret}`
      : behavior.resultFormat === 'oversized' ? JSON.stringify({ summary: secret.repeat(10000) })
      : JSON.stringify({ summary: secret });
    if (behavior.resultTarget) {
      if (behavior.resultLink === 'parent') {
        const parent = path.dirname(resultFile);
        fs.renameSync(parent, `${parent}.preserved`);
        fs.symlinkSync(behavior.resultTarget, parent, process.platform === 'win32' ? 'junction' : 'dir');
      } else if (behavior.resultLink === 'hardlink') fs.linkSync(behavior.resultTarget, resultFile);
      else if (behavior.resultLink === 'directory') fs.mkdirSync(resultFile);
      else fs.symlinkSync(behavior.resultTarget, resultFile);
    } else if (behavior.resultFormat !== 'missing') fs.writeFileSync(resultFile, metadata);
    if (behavior.resultFailure === 'artifact') fs.writeFileSync(resultFile.replace(/\.result\.json$/, '.stdout.log'), 'provider-owned log');
    if (behavior.resultFailure === 'timeout' || behavior.resultFailure === 'interrupted') await new Promise(resolve => setTimeout(resolve, 30000));
    emitUsage(true);
    event('end');
    process.exitCode = ['linked', 'success'].includes(behavior.resultFailure) ? 0 : 17;
    return;
  }
  if (role === 'codex') {
    if (configuration.mutateReview) fs.appendFileSync('README.md', 'unauthorized review mutation\n');
    if (configuration.mutateReviewRef) git('branch', '-f', 'main', 'HEAD');
    const hasFix = fs.existsSync('feature/fix.txt');
    const findings = configuration.findings ?? (configuration.alwaysFindings || (!hasFix && configuration.reviewFindings)
      ? [
          { severity: 'P1', message: 'Feature must include the missing guard.', file: 'feature/a.txt', line: 1 },
          { severity: 'P3', message: 'Prefer an unrelated stylistic convention.', file: 'feature/b.txt', line: 1 },
        ]
      : []);
    const outputIndex = process.argv.indexOf('--output-last-message');
    if (outputIndex < 0) throw new Error('Review must use an explicit structured output file.');
    fs.writeFileSync(process.argv[outputIndex + 1], JSON.stringify({ findings }));
    emitUsage();
    event('end');
    return;
  }
  if (behavior.stderrBytes) process.stderr.write('WORKER_PRIVATE_TRANSCRIPT'.repeat(Math.ceil(behavior.stderrBytes / 25)));
  if (behavior.stdoutBytes) process.stdout.write('WORKER_PRIVATE_TRANSCRIPT'.repeat(Math.ceil(behavior.stdoutBytes / 25)));
  if (behavior.fail) {
    emitUsage(true);
    event('end');
    process.exitCode = 17;
    return;
  }
  for (const dependency of behavior.requiresFiles ?? []) {
    if (!fs.existsSync(dependency)) throw new Error(`Missing integrated dependency: ${dependency}`);
  }
  const file = behavior.file ?? request.task.writeScope[0].replace(/\/\*\*$/, '') + (request.task.writeScope[0].endsWith('.txt') ? '' : '/result.txt');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, behavior.content ?? `${taskId}\n`);
  git('add', '--', file);
  git('commit', '-m', `Implement ${taskId}`);
  const commitSha = git('rev-parse', 'HEAD');
  if (behavior.dirty) fs.writeFileSync('uncommitted-user-work.txt', 'preserve this work\n');
  if (behavior.badBranch) git('switch', '-c', `unexpected-${taskId}`);
  if (behavior.protectedRef === 'branch') git('update-ref', 'refs/heads/main', 'HEAD');
  if (behavior.protectedRef === 'branch-add') git('update-ref', `refs/heads/provider-${taskId}`, 'HEAD');
  if (behavior.protectedRef === 'branch-delete') git('update-ref', '-d', 'refs/heads/protected-existing');
  if (behavior.protectedRef === 'tag') git('update-ref', `refs/tags/provider-${taskId}`, 'HEAD');
  if (behavior.protectedRef === 'tag-move') git('update-ref', 'refs/tags/protected-existing', 'HEAD');
  if (behavior.protectedRef === 'tag-delete') git('update-ref', '-d', 'refs/tags/protected-existing');
  if (behavior.protectedRef === 'checkpoint') git('update-ref', `refs/codex/turn-diffs/checkpoints/provider-${taskId}`, 'HEAD');
  if (behavior.protectedRef === 'overflow') {
    for (let index = 0; index < 40; index++) git('update-ref', `refs/tags/provider-${taskId}-${index}`, 'HEAD');
  }
  const handoff = {
    taskId: behavior.handoffTaskId ?? taskId, outcome: 'completed', commitSha, changedFiles: [file],
    tests: request.task.tests.map(test => ({ ...test, passed: true })),
    interfaceChanges: behavior.metadata ?? [], assumptions: behavior.metadata ?? [], risks: behavior.metadata ?? [],
    summary: behavior.summary ?? `Completed ${taskId}.`,
  };
  const handoffBytes = behavior.prettyResult ? `${JSON.stringify(handoff, null, 2)}\n` : JSON.stringify(handoff);
  if (behavior.publication === 'stdout-only') process.stdout.write(handoffBytes);
  else if (behavior.publication === 'local-only') {
    const local = path.join(process.cwd(), '.omc', 'helper-results', `${taskId}.json`);
    fs.mkdirSync(path.dirname(local), { recursive: true });
    fs.writeFileSync(local, handoffBytes);
  } else fs.writeFileSync(request.resultFile, handoffBytes);
  emitUsage();
  event('end');
})().catch(error => {
  process.stderr.write(String(error));
  process.exitCode = 1;
});
