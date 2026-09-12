import { describe, expect, it } from 'vitest';
import { parseWorkflowPlan, parseWorkflowTask } from '../workflow-contracts.js';

const task = {
  id: 'a', objective: 'Implement a', baseCommit: 'a'.repeat(40),
  writeScope: ['feature/a.txt'], readScope: ['README.md'], prohibitedScope: ['package.json'],
  dependencies: [], contracts: ['Keep public APIs stable.'], acceptanceCriteria: ['Scoped output exists.'], tests: [],
};
const plan = {
  name: 'feature', objective: 'Implement feature', baseCommit: 'a'.repeat(40), integrationBranch: 'integration/feature',
  tasks: [task], verification: [{ command: 'node', args: ['-e', 'process.exit(0)'] }],
};

describe('workflow plan boundaries', () => {
  it('rejects overlapping write ownership without a dependency', () => {
    expect(() => parseWorkflowPlan({ ...plan, tasks: [task, { ...task, id: 'b', writeScope: ['feature'] }] }))
      .toThrow(/overlap/);
  });

  it('permits overlapping ownership when the later task depends on the owner', () => {
    expect(parseWorkflowPlan({ ...plan, tasks: [task, { ...task, id: 'b', dependencies: ['a'] }] }).tasks).toHaveLength(2);
  });

  it.each(['../outside', '/absolute', 'C:/outside', '.git/config', '.omc/state', 'src/**/foo', 'src/../../outside'])(
    'rejects unsafe ownership scope %s', writeScope => {
    expect(() => parseWorkflowTask({ ...task, writeScope: [writeScope] })).toThrow(/scope/);
    },
  );

  it('rejects a write scope containing a prohibited subtree', () => {
    expect(() => parseWorkflowPlan({ ...plan, tasks: [{ ...task, writeScope: ['src'], prohibitedScope: ['src/auth'] }] }))
      .toThrow(/prohibited/);
  });

  it('requires deterministic integration verification', () => {
    expect(() => parseWorkflowPlan({ ...plan, verification: [] })).toThrow(/verification/);
  });

  it('rejects dependency cycles and missing dependencies', () => {
    expect(() => parseWorkflowPlan({ ...plan, tasks: [{ ...task, dependencies: ['missing'] }] })).toThrow(/dependency/);
    expect(() => parseWorkflowPlan({ ...plan, tasks: [{ ...task, dependencies: ['a'] }] })).toThrow(/cycle/);
  });
});
