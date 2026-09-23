import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isTmuxAvailable, tmuxExec } from '../tmux-utils.js';

describe.skipIf(process.platform !== 'win32')('tmux-utils native Windows batch invocation', () => {
  it('runs availability and tmux commands through an npm-style .cmd shim', () => {
    const directory = mkdtempSync(join(tmpdir(), 'omc-tmux-shim-'));
    const shim = join(directory, 'tmux.cmd');
    const script = 'process.stdout.write(JSON.stringify(process.argv.slice(1)))';
    writeFileSync(shim, `@echo off\r\nif "%~1"=="-V" exit /b 0\r\n"${process.execPath}" -e "${script}" %*\r\n`);

    const previousPath = process.env.PATH;
    const previousPathext = process.env.PATHEXT;
    const previousComspec = process.env.COMSPEC;
    try {
      process.env.PATH = `${directory}${delimiter}${previousPath ?? ''}`;
      process.env.PATHEXT = '.COM;.EXE;.BAT;.CMD';
      process.env.COMSPEC = 'C:\\attacker\\cmd.exe';

      expect(isTmuxAvailable()).toBe(true);
      const expected = ['send-keys', 'space and & literal', 'bang!literal', 'caret^literal',
        'quote"literal', 'quote" & echo INJECTED & rem "literal'];
      expect(JSON.parse(tmuxExec(expected))).toEqual(expected);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousPathext === undefined) delete process.env.PATHEXT;
      else process.env.PATHEXT = previousPathext;
      if (previousComspec === undefined) delete process.env.COMSPEC;
      else process.env.COMSPEC = previousComspec;
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
