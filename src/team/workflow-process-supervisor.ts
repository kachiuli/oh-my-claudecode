import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

const WORKFLOW_SUPERVISOR_ENV = 'OMC_WORKFLOW_PROCESS_SUPERVISOR';
const WORKFLOW_SUPERVISOR_PROTOCOL = 'omc-workflow-process-supervisor-v1';
const WORKFLOW_SUPERVISOR_REPAIR_NAMES: ReadonlySet<string> = new Set([
  'PSMODULEPATH', 'PATHEXT', '__COMPAT_LAYER',
]);

export interface SupervisedWorkflowInvocation {
  command: string;
  args: string[];
  environment: NodeJS.ProcessEnv;
}

interface IntendedEnvironmentEntry {
  name: string;
  canonicalName: string;
  value: string;
}

function compareOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Reject ambiguous Windows keys, then order the provider's exact environment deterministically. */
function intendedWindowsEnvironment(environment: NodeJS.ProcessEnv): IntendedEnvironmentEntry[] {
  const seen = new Set<string>();
  const entries: IntendedEnvironmentEntry[] = [];
  for (const [name, value] of Object.entries(environment).sort(([left], [right]) => compareOrdinal(left, right))) {
    if (value === undefined) continue;
    if (!name || /[=\0]/.test(name) || typeof value !== 'string' || value.includes('\0')) {
      throw new Error('workflow_supervisor_environment_invalid');
    }
    const canonicalName = name.toUpperCase();
    if (canonicalName === WORKFLOW_SUPERVISOR_ENV) continue;
    if (seen.has(canonicalName)) throw new Error('workflow_supervisor_environment_invalid');
    seen.add(canonicalName);
    entries.push({ name, canonicalName, value });
  }
  return entries.sort((left, right) => compareOrdinal(left.canonicalName, right.canonicalName));
}

function environmentDigest(entries: readonly IntendedEnvironmentEntry[]): string {
  const canonical = entries.map(entry => (
    `${entry.canonicalName.length}:${entry.canonicalName}${entry.value.length}:${entry.value}\n`
  )).join('');
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * Keep controller-facing stdio open until a Windows Job Object has accounted
 * for the provider and every process it created.
 */
export function buildWindowsWorkflowSupervisorSource(): string {
  const interop = [
    'using System; using System.Text; using System.Runtime.InteropServices;',
    'public static class O {',
    '[StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct STARTUPINFO {',
    'public int cb; public IntPtr lpReserved; public IntPtr lpDesktop; public IntPtr lpTitle;',
    'public int dwX; public int dwY; public int dwXSize; public int dwYSize; public int dwXCountChars; public int dwYCountChars;',
    'public int dwFillAttribute; public int dwFlags; public short wShowWindow; public short cbReserved2; public IntPtr lpReserved2;',
    'public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError; }',
    '[StructLayout(LayoutKind.Sequential)] public struct STARTUPINFOEX { public STARTUPINFO StartupInfo; public IntPtr lpAttributeList; }',
    '[StructLayout(LayoutKind.Sequential)] public struct PROCESS_INFORMATION { public IntPtr hProcess; public IntPtr hThread; public uint dwProcessId; public uint dwThreadId; }',
    '[StructLayout(LayoutKind.Sequential)] public struct JOBOBJECT_BASIC_LIMIT_INFORMATION { public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass; }',
    '[StructLayout(LayoutKind.Sequential)] public struct IO_COUNTERS { public ulong ReadOperationCount; public ulong WriteOperationCount; public ulong OtherOperationCount; public ulong ReadTransferCount; public ulong WriteTransferCount; public ulong OtherTransferCount; }',
    '[StructLayout(LayoutKind.Sequential)] public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION { public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation; public IO_COUNTERS IoInfo; public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit; public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed; }',
    '[DllImport("kernel32.dll")] public static extern IntPtr GetCurrentProcess();',
    '[DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr GetStdHandle(int kind);',
    '[DllImport("kernel32.dll", SetLastError=true)] public static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr source, IntPtr targetProcess, out IntPtr target, uint access, bool inherit, uint options);',
    '[DllImport("kernel32.dll", SetLastError=true)] public static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, uint flags, ref UIntPtr size);',
    '[DllImport("kernel32.dll", SetLastError=true)] public static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, UIntPtr size, IntPtr previous, IntPtr returned);',
    '[DllImport("kernel32.dll")] public static extern void DeleteProcThreadAttributeList(IntPtr list);',
    '[DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool CreateProcessW(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string dir, ref STARTUPINFOEX si, out PROCESS_INFORMATION pi);',
    '[DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr CreateJobObjectW(IntPtr a, string n);',
    '[DllImport("kernel32.dll", SetLastError=true)] public static extern bool SetInformationJobObject(IntPtr j, int c, IntPtr i, uint l);',
    '[DllImport("kernel32.dll", SetLastError=true)] public static extern bool AssignProcessToJobObject(IntPtr j, IntPtr p);',
    '[DllImport("kernel32.dll", SetLastError=true)] public static extern uint ResumeThread(IntPtr h);',
    '[DllImport("kernel32.dll", SetLastError=true)] public static extern bool TerminateJobObject(IntPtr j, uint c);',
    '[DllImport("kernel32.dll", SetLastError=true)] public static extern bool TerminateProcess(IntPtr p, uint c);',
    '[DllImport("kernel32.dll", SetLastError=true)] public static extern uint WaitForSingleObject(IntPtr h, uint ms);',
    '[DllImport("kernel32.dll", SetLastError=true)] public static extern bool GetExitCodeProcess(IntPtr h, out uint code);',
    '[DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);',
    'public static string Quote(string value) { var b = new StringBuilder(); b.Append((char)34); int slashes = 0; foreach (var c in value) { if (c == (char)92) { slashes++; continue; } if (c == (char)34) { b.Append((char)92, slashes * 2 + 1); b.Append((char)34); slashes = 0; continue; } b.Append((char)92, slashes); slashes = 0; b.Append(c); } b.Append((char)92, slashes * 2); b.Append((char)34); return b.ToString(); }',
    'public static string BuildCommandLine(string[] argv, bool verbatim) { var b = new StringBuilder(); b.Append(Quote(argv[0])); for (var i = 1; i < argv.Length; i++) { b.Append((char)32); b.Append(verbatim ? argv[i] : Quote(argv[i])); } return b.ToString(); }',
    '}',
  ].join('\n');
  return [
    '$ErrorActionPreference = "Stop"',
    '$ProgressPreference = "SilentlyContinue"',
    `$encoded = [Environment]::GetEnvironmentVariable("${WORKFLOW_SUPERVISOR_ENV}", "Process")`,
    `if ([String]::IsNullOrWhiteSpace($encoded)) { throw "workflow_supervisor_config_missing" }; [Environment]::SetEnvironmentVariable("${WORKFLOW_SUPERVISOR_ENV}", $null, "Process")`,
    '$payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encoded)) | ConvertFrom-Json',
    `if ($payload.protocol -ne "${WORKFLOW_SUPERVISOR_PROTOCOL}" -or @($payload.argv).Count -lt 1 -or $payload.environment_digest -notmatch "^[0-9a-f]{64}$") { throw "workflow_supervisor_config_invalid" }`,
    'Add-Type @"',
    interop,
    '"@',
    '$M = [Runtime.InteropServices.Marshal]; $pi = New-Object O+PROCESS_INFORMATION; $job = [IntPtr]::Zero; $envPtr = [IntPtr]::Zero; $attributeList = [IntPtr]::Zero; $handleList = [IntPtr]::Zero; $stdin = [IntPtr]::Zero; $stdout = [IntPtr]::Zero; $stderr = [IntPtr]::Zero; $exitCode = [uint32]1',
    'try {',
    '  $current = [O]::GetCurrentProcess(); if (-not [O]::DuplicateHandle($current, [O]::GetStdHandle(-10), $current, [ref]$stdin, 0, $true, 2) -or -not [O]::DuplicateHandle($current, [O]::GetStdHandle(-11), $current, [ref]$stdout, 0, $true, 2) -or -not [O]::DuplicateHandle($current, [O]::GetStdHandle(-12), $current, [ref]$stderr, 0, $true, 2)) { throw "workflow_supervisor_stdio_duplicate_failed" }',
    '  $attributeBytes = [UIntPtr]::Zero; [O]::InitializeProcThreadAttributeList([IntPtr]::Zero, 1, 0, [ref]$attributeBytes) | Out-Null; $attributeList = $M::AllocHGlobal([int64]$attributeBytes.ToUInt64()); if (-not [O]::InitializeProcThreadAttributeList($attributeList, 1, 0, [ref]$attributeBytes)) { throw "workflow_supervisor_attribute_init_failed" }; $handleList = $M::AllocHGlobal([IntPtr]::Size * 3); $M::WriteIntPtr($handleList, 0, $stdin); $M::WriteIntPtr($handleList, [IntPtr]::Size, $stdout); $M::WriteIntPtr($handleList, [IntPtr]::Size * 2, $stderr); $handleBytes = [UIntPtr]([uint64]([IntPtr]::Size * 3)); if (-not [O]::UpdateProcThreadAttribute($attributeList, 0, [IntPtr]0x00020002, $handleList, $handleBytes, [IntPtr]::Zero, [IntPtr]::Zero)) { throw "workflow_supervisor_attribute_update_failed" }',
    '  $intendedNames = @($payload.environment_keys); $repairs = @($payload.environment_repairs); $repairValues = @{}; if ($repairs.Count -gt 3) { throw "workflow_supervisor_environment_repair_invalid" }; foreach ($repair in $repairs) { if (@("PSMODULEPATH", "PATHEXT", "__COMPAT_LAYER") -notcontains [string]$repair.name -or $intendedNames -notcontains [string]$repair.name) { throw "workflow_supervisor_environment_repair_invalid" }; $repairValues[[string]$repair.name] = [string]$repair.value }',
    '  $environment = [Environment]::GetEnvironmentVariables("Process"); $live = @{}; foreach ($key in $environment.Keys) { $live[[string]$key] = [string]$environment[$key] }; $seen = @{}; $envPairs = @(); $digestInput = New-Object Text.StringBuilder; foreach ($nameValue in $intendedNames) { $name = [string]$nameValue; if ([String]::IsNullOrEmpty($name) -or $name.Contains("=") -or $name.Contains([char]0)) { throw "workflow_supervisor_environment_key_invalid" }; $canonical = $name.ToUpperInvariant(); if ($seen.ContainsKey($canonical) -or (-not $repairValues.ContainsKey($name) -and -not $live.ContainsKey($name))) { throw "workflow_supervisor_environment_mismatch" }; $seen[$canonical] = $true; $value = if ($repairValues.ContainsKey($name)) { [string]$repairValues[$name] } else { [string]$live[$name] }; [void]$digestInput.Append($canonical.Length).Append(":").Append($canonical).Append($value.Length).Append(":").Append($value).Append([char]10); $envPairs += "$name=$value" }; $digestBytes = [Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($digestInput.ToString())); $digest = ($digestBytes | ForEach-Object { $_.ToString("x2") }) -join ""; if ($digest -ne [string]$payload.environment_digest) { throw "workflow_supervisor_environment_mismatch" }',
    '  $envText = (($envPairs -join [char]0) + [char]0 + [char]0); $envBytes = [Text.Encoding]::Unicode.GetBytes($envText); $envPtr = $M::AllocHGlobal($envBytes.Length); $M::Copy($envBytes, 0, $envPtr, $envBytes.Length)',
    '  $argv = [string[]]$payload.argv; $cmd = [O]::BuildCommandLine($argv, [bool]$payload.windows_verbatim_arguments); $application = if ([IO.Path]::IsPathRooted($argv[0])) { $argv[0] } else { $null }; $si = New-Object O+STARTUPINFOEX; $startup = New-Object O+STARTUPINFO; $startup.cb = $M::SizeOf($si); $startup.dwFlags = 0x100; $startup.hStdInput = $stdin; $startup.hStdOutput = $stdout; $startup.hStdError = $stderr; $si.StartupInfo = $startup; $si.lpAttributeList = $attributeList; $flags = 0x00000004 -bor 0x00000400 -bor 0x00080000 -bor 0x08000000; if (-not [O]::CreateProcessW($application, $cmd, [IntPtr]::Zero, [IntPtr]::Zero, $true, $flags, $envPtr, [string]$payload.cwd, [ref]$si, [ref]$pi)) { throw ("workflow_supervisor_create_process_failed:" + $M::GetLastWin32Error()) }',
    '  $job = [O]::CreateJobObjectW([IntPtr]::Zero, $null); if ($job -eq [IntPtr]::Zero) { throw "workflow_supervisor_create_job_failed" }; $info = New-Object O+JOBOBJECT_EXTENDED_LIMIT_INFORMATION; $basic = New-Object O+JOBOBJECT_BASIC_LIMIT_INFORMATION; $basic.LimitFlags = 0x2000; $info.BasicLimitInformation = $basic; $infoPtr = $M::AllocHGlobal($M::SizeOf($info)); try { $M::StructureToPtr($info, $infoPtr, $false); if (-not [O]::SetInformationJobObject($job, 9, $infoPtr, $M::SizeOf($info))) { throw "workflow_supervisor_job_config_failed" } } finally { $M::FreeHGlobal($infoPtr) }; if (-not [O]::AssignProcessToJobObject($job, $pi.hProcess)) { throw "workflow_supervisor_assign_job_failed" }; if ([O]::ResumeThread($pi.hThread) -eq [uint32]::MaxValue) { throw "workflow_supervisor_resume_failed" }',
    '  if ([O]::WaitForSingleObject($pi.hProcess, [uint32]::MaxValue) -ne 0) { throw "workflow_supervisor_provider_wait_failed" }; if (-not [O]::GetExitCodeProcess($pi.hProcess, [ref]$exitCode)) { throw "workflow_supervisor_exit_code_failed" }; if (-not [O]::TerminateJobObject($job, $exitCode)) { throw "workflow_supervisor_job_terminate_failed" }; if ([O]::WaitForSingleObject($job, 5000) -ne 0) { throw "workflow_supervisor_job_cleanup_timeout" }',
    '} catch { if ($pi.hProcess -ne [IntPtr]::Zero) { if ($job -ne [IntPtr]::Zero) { [O]::TerminateJobObject($job, 1) | Out-Null }; [O]::TerminateProcess($pi.hProcess, 1) | Out-Null; [O]::WaitForSingleObject($pi.hProcess, 5000) | Out-Null }; [Console]::Error.WriteLine($_.Exception.Message); $exitCode = 1 } finally { if ($attributeList -ne [IntPtr]::Zero) { [O]::DeleteProcThreadAttributeList($attributeList); $M::FreeHGlobal($attributeList) }; if ($handleList -ne [IntPtr]::Zero) { $M::FreeHGlobal($handleList) }; if ($envPtr -ne [IntPtr]::Zero) { $M::FreeHGlobal($envPtr) }; foreach ($handle in @($stdin, $stdout, $stderr, $pi.hThread, $pi.hProcess, $job)) { if ($handle -ne [IntPtr]::Zero) { [O]::CloseHandle($handle) | Out-Null } } }',
    'exit ([BitConverter]::ToInt32([BitConverter]::GetBytes($exitCode), 0))',
  ].join('\n');
}

function encodePowerShell(source: string): string {
  return Buffer.from(source, 'utf16le').toString('base64');
}

export function superviseWindowsWorkflowInvocation(input: {
  command: string;
  args: readonly string[];
  cwd: string;
  environment: NodeJS.ProcessEnv;
  windowsVerbatimArguments?: boolean;
}): SupervisedWorkflowInvocation {
  if (!input.command || /[\0\r\n]/.test(input.command)
    || input.args.some(argument => typeof argument !== 'string' || argument.includes('\0'))
    || !input.cwd || input.cwd.includes('\0')) {
    throw new Error('workflow_supervisor_process_arguments_invalid');
  }
  const systemRoot = process.env.SystemRoot ?? input.environment.SystemRoot ?? input.environment.SYSTEMROOT;
  if (!systemRoot || !isAbsolute(systemRoot)) throw new Error('workflow_supervisor_unavailable');
  const powershell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  if (!existsSync(powershell)) throw new Error('workflow_supervisor_unavailable');
  const intendedEnvironment = intendedWindowsEnvironment(input.environment);
  const environmentRepairs = intendedEnvironment
    .filter(entry => WORKFLOW_SUPERVISOR_REPAIR_NAMES.has(entry.canonicalName))
    .map(entry => ({ name: entry.name, value: entry.value }));
  const configuration = Buffer.from(JSON.stringify({
    protocol: WORKFLOW_SUPERVISOR_PROTOCOL,
    argv: [input.command, ...input.args],
    cwd: input.cwd,
    windows_verbatim_arguments: input.windowsVerbatimArguments === true,
    environment_keys: intendedEnvironment.map(entry => entry.name),
    environment_digest: environmentDigest(intendedEnvironment),
    environment_repairs: environmentRepairs,
  }), 'utf8').toString('base64');
  if (configuration.length > 30_000) throw new Error('workflow_supervisor_configuration_too_large');
  // PowerShell mutates these values during startup. Carry the intended values as bounded,
  // digest-covered repairs and restore them only in the provider environment block.
  const environment = Object.fromEntries(intendedEnvironment
    .filter(entry => !WORKFLOW_SUPERVISOR_REPAIR_NAMES.has(entry.canonicalName))
    .map(entry => [entry.name, entry.value]));
  environment[WORKFLOW_SUPERVISOR_ENV] = configuration;
  return {
    command: powershell,
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowerShell(buildWindowsWorkflowSupervisorSource())],
    environment,
  };
}
