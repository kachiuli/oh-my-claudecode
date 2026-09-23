import { existsSync, realpathSync } from 'fs';
import { win32 as win32Path } from 'path';
const SYSTEM_COMMAND_PROCESSOR = 'C:\\Windows\\System32\\cmd.exe';
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';
/** Prefer a Windows PATH candidate with an executable PATHEXT suffix. */
export function selectWindowsExecutableCandidate(candidates, pathext = process.env.PATHEXT ?? DEFAULT_PATHEXT) {
    const executableExtensions = new Set(pathext.split(';')
        .map(extension => extension.trim().toLowerCase()).filter(Boolean));
    return candidates.find(candidate => executableExtensions.has(win32Path.extname(candidate).toLowerCase()))
        ?? candidates[0];
}
function isAbsoluteCmdExe(candidate) {
    if (!candidate || /[\0\r\n]/.test(candidate) || /[\\/]$/.test(candidate))
        return false;
    return win32Path.isAbsolute(candidate) && win32Path.basename(candidate).toLowerCase() === 'cmd.exe';
}
/** Return only the canonical Windows system command processor; inherited COMSPEC is untrusted. */
export function validatedComspec() {
    try {
        if (!existsSync(SYSTEM_COMMAND_PROCESSOR))
            return undefined;
        const canonical = realpathSync(SYSTEM_COMMAND_PROCESSOR);
        if (!isAbsoluteCmdExe(canonical))
            return undefined;
        if (win32Path.normalize(canonical).toLowerCase() !== win32Path.normalize(SYSTEM_COMMAND_PROCESSOR).toLowerCase()) {
            return undefined;
        }
        return canonical;
    }
    catch {
        return undefined;
    }
}
function quoteWindowsBatchArgument(value) {
    // cmd expands percent references before the batch shim sees them. Refuse
    // values whose literal meaning cannot be preserved by this invocation form.
    if (/[\0\r\n%]/.test(value))
        throw new Error('Unsafe Windows batch argument');
    return `"${value.replace(/"/g, '""')}"`;
}
/** Build a literal cmd.exe invocation for a resolved .cmd/.bat shim. */
export function resolveWindowsBatchInvocation(command, args) {
    const comspec = validatedComspec();
    if (!comspec)
        throw new Error('No validated Windows command processor is available');
    const commandLine = `"${[command, ...args].map(quoteWindowsBatchArgument).join(' ')}"`;
    return {
        command: comspec,
        args: ['/d', '/v:off', '/s', '/c', commandLine],
        windowsVerbatimArguments: true,
    };
}
//# sourceMappingURL=windows-command.js.map