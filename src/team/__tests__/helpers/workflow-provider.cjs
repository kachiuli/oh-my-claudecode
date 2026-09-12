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
function event(event) {
  fs.appendFileSync(configuration.eventsPath, JSON.stringify({
    role, event, taskId, cwd: process.cwd(), branch: git('branch', '--show-current'),
    time: Date.now(), args: process.argv.slice(2), prompt: JSON.stringify(request),
  }) + '\n');
}

(async () => {
  event('start');
  if (role === 'glm' && configuration.barrierCount) {
    const deadline = Date.now() + 10000;
    while (fs.readFileSync(configuration.eventsPath, 'utf8').split('\n').filter(line => line && JSON.parse(line).event === 'start').length < configuration.barrierCount) {
      if (Date.now() > deadline) throw new Error('Requested workers did not launch concurrently.');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  await new Promise(resolve => setTimeout(resolve, behavior.delayMs ?? configuration.delayMs ?? 0));
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
    event('end');
    return;
  }
  if (behavior.stderrBytes) process.stderr.write('WORKER_PRIVATE_TRANSCRIPT'.repeat(Math.ceil(behavior.stderrBytes / 25)));
  if (behavior.stdoutBytes) process.stdout.write('WORKER_PRIVATE_TRANSCRIPT'.repeat(Math.ceil(behavior.stdoutBytes / 25)));
  if (behavior.fail) {
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
  const handoff = {
    taskId, outcome: 'completed', commitSha, changedFiles: [file],
    tests: request.task.tests.map(test => ({ ...test, passed: true })),
    interfaceChanges: behavior.metadata ?? [], assumptions: behavior.metadata ?? [], risks: behavior.metadata ?? [],
    summary: behavior.summary ?? `Completed ${taskId}.`,
  };
  fs.writeFileSync(request.resultFile, JSON.stringify(handoff));
  event('end');
})().catch(error => {
  process.stderr.write(String(error));
  process.exitCode = 1;
});
