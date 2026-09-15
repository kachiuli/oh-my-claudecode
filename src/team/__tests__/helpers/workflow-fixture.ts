import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface FixtureEvent {
  role: 'glm' | 'codex';
  event: 'start' | 'end';
  taskId: string;
  cwd: string;
  branch: string;
  time: number;
  args: string[];
  prompt: string;
}

/** An actual repository and actual child providers, without credentials or shell wrappers. */
export function createWorkflowFixture() {
  const root = mkdtempSync(join(tmpdir(), 'omc-workflow-'));
  const cwd = join(root, 'repo');
  mkdirSync(cwd);
  const git = (...args: string[]) => execFileSync('git', args, {
    cwd, encoding: 'utf8', stdio: 'pipe', windowsHide: true,
  }).trim();
  git('init', '-b', 'main');
  git('config', 'user.name', 'Workflow Fixture');
  git('config', 'user.email', 'workflow@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.autocrlf', 'false');
  writeFileSync(join(cwd, '.gitignore'), '.omc/\n');
  writeFileSync(join(cwd, 'README.md'), '# Workflow fixture\n');
  git('add', '.');
  git('commit', '-m', 'Fixture base');
  const baseCommit = git('rev-parse', 'HEAD');
  const configPath = join(root, 'fixture.json');
  const eventsPath = join(root, 'events.jsonl');
  writeFileSync(eventsPath, '');
  writeFileSync(configPath, JSON.stringify({ eventsPath }));
  return {
    root, cwd, git, baseCommit, configPath, eventsPath,
    configure(config: Record<string, unknown>) {
      writeFileSync(configPath, JSON.stringify({ eventsPath, ...config }));
    },
    events(): FixtureEvent[] {
      return readFileSync(eventsPath, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
    },
    dispose() {
      // All generated worktrees live inside this uniquely allocated temporary directory.
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}
