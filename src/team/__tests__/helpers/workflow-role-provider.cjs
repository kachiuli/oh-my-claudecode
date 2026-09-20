/* global require, process, setTimeout */
/* eslint-disable @typescript-eslint/no-require-imports -- Credential-free native child fixture. */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const config = JSON.parse(fs.readFileSync(process.env.OMC_WORKFLOW_TEST_CONFIG, 'utf8'));
const request = JSON.parse(fs.readFileSync(0, 'utf8'));
const args = process.argv.slice(2);
const role = request.kind === 'review' ? 'reviewer' : 'implementer';
const behavior = config.tasks?.[request.task?.id ?? 'review'] ?? {};
const git = (...args) => execFileSync('git', args, { cwd: process.cwd(), encoding: 'utf8', stdio: 'pipe', windowsHide: true }).trim();
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
const event = value => fs.appendFileSync(config.eventsPath, JSON.stringify({ role, args, cwd: process.cwd(), route: process.env.FIXTURE_ROUTE,
  environmentKeys: Object.keys(process.env), request, ...value }) + '\n');
const sessionId = args.includes('--resume') ? args[args.indexOf('--resume') + 1] : args.includes('--session-id')
  ? args[args.indexOf('--session-id') + 1] : '22222222-2222-4222-8222-222222222222';
const terminal = output => {
  if (args[0] === 'exec') emit({ type: 'turn.completed', usage: { input_tokens: 12, cached_input_tokens: 3, output_tokens: 4 } });
  else emit({ type: 'result', subtype: 'success', is_error: false, session_id: sessionId,
    ...(output === undefined ? {} : { structured_output: output }),
    ...(behavior.noUsage ? {} : { usage: { input_tokens: 9, output_tokens: 4, cache_read_input_tokens: 3, cache_creation_input_tokens: 0 } }) });
};
(async () => {
  event({ event: 'start' });
  if (behavior.authFileSecret) process.stderr.write(JSON.parse(fs.readFileSync(process.env.FIXTURE_AUTH_FILE, 'utf8')).accessToken);
  if (args[0] !== 'exec') emit({ type: 'system', subtype: 'init', session_id: sessionId });
  if (behavior.echoSecret) process.stderr.write(process.env.PRIVATE_TEST_SECRET ?? 'missing-private-secret');
  if (behavior.failBeforeWork) { process.stderr.write('synthetic provider unavailable'); process.exitCode = 17; return; }
  if (behavior.delayMs) await new Promise(resolve => setTimeout(resolve, behavior.delayMs));
  if (role === 'reviewer') {
    if (behavior.deepStructured) {
      process.stdout.write('{"type":"result","subtype":"success","is_error":false,"structured_output":' + '['.repeat(12000) + '0' + ']'.repeat(12000) + '}\n');
      return;
    }
    if (behavior.mutateSource) fs.appendFileSync('README.md', 'unauthorized mutation\n');
    if (behavior.mutateRef) git('branch', '-f', 'main', 'HEAD');
    const result = { findings: config.findings ?? [] };
    if (args[0] === 'exec') fs.writeFileSync(args[args.indexOf('--output-last-message') + 1], JSON.stringify(result));
    terminal(behavior.omitStructuredResult ? undefined : result);
    if (behavior.conflictingTerminal) terminal({ findings: [{ severity: 'P0', message: 'Conflicting synthetic terminal', file: null, line: null }] });
    return;
  }
  const file = behavior.file ?? request.task.writeScope[0];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'complete synthetic component\n');
  if (behavior.partialHang) await new Promise(resolve => setTimeout(resolve, 30000));
  git('add', '--', file); git('commit', '-m', 'Synthetic implementation');
  if (behavior.extraCommit) { fs.appendFileSync(file, 'second commit\n'); git('add', '--', file); git('commit', '-m', 'Extra synthetic commit'); }
  if (behavior.mutateRef) git('branch', '-f', 'main', 'HEAD');
  if (behavior.protectedRef === 'checkpoint') git('update-ref', `refs/codex/turn-diffs/checkpoints/provider-${request.task.id}`, 'HEAD');
  if (behavior.commitHang) await new Promise(resolve => setTimeout(resolve, 30000));
  const result = { taskId: request.task.id, outcome: 'completed', commitSha: git('rev-parse', 'HEAD'), changedFiles: [file],
    tests: behavior.omitTests ? [] : request.task.tests.map(test => ({ ...test, passed: true })),
    interfaceChanges: [], assumptions: [], risks: [], summary: behavior.echoSecret ? process.env.PRIVATE_TEST_SECRET : 'Synthetic implementation complete.' };
  if (!behavior.omitHandoff) {
    const bytes = behavior.malformedHandoff ? '{}' : behavior.spacedResult ? ` ${JSON.stringify(result)} \n` : JSON.stringify(result);
    if (behavior.publication === 'stdout-only') process.stdout.write(`${bytes}\n`);
    else if (behavior.publication === 'local-only') {
      const local = path.join(process.cwd(), '.omc', 'helper-results', `${request.task.id}.json`);
      fs.mkdirSync(path.dirname(local), { recursive: true });
      fs.writeFileSync(local, bytes);
    } else fs.writeFileSync(request.resultFile, bytes);
  }
  terminal();
  event({ event: 'end' });
})().catch(error => { process.stderr.write(String(error)); process.exitCode = 1; });
