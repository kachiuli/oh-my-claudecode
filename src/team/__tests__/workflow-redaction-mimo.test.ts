import { describe, expect, it } from 'vitest';
import { redactWorkflowText } from '../workflow-process.js';

describe('MiMo credential redaction', () => {
  it.each(['tp-exampletoken123', 'ttp-exampletoken123'])('removes a Token Plan key from captured output', key => {
    expect(redactWorkflowText(`provider error: ${key}`)).toBe('provider error: [REDACTED]');
  });
});
