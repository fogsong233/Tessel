import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, extname, isAbsolute, join } from 'node:path';

export interface WindowsUpdateHelperOptions {
  installerPath: string;
  installDirectory: string;
  targetExecutablePath: string;
  currentProcessId: number;
  logPath: string;
}

export async function launchWindowsUpdateHelper(options: WindowsUpdateHelperOptions): Promise<void> {
  validateOptions(options);
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
  const powershellPath = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  if (!existsSync(powershellPath)) {
    throw new Error(`Windows PowerShell was not found at ${powershellPath}`);
  }

  const encodedCommand = Buffer.from(buildWindowsUpdateHelperScript(options), 'utf16le').toString('base64');
  await new Promise<void>((resolve, reject) => {
    const helper = spawn(powershellPath, [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-WindowStyle',
      'Hidden',
      '-EncodedCommand',
      encodedCommand
    ], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    });

    helper.once('spawn', () => {
      helper.unref();
      resolve();
    });
    helper.once('error', reject);
  });
}

export function buildWindowsUpdateHelperScript(options: WindowsUpdateHelperOptions): string {
  const processName = basename(options.targetExecutablePath, extname(options.targetExecutablePath));
  return String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$installerPath = ${powerShellLiteral(options.installerPath)}
$installDirectory = ${powerShellLiteral(options.installDirectory)}
$targetExecutable = ${powerShellLiteral(options.targetExecutablePath)}
$targetProcessName = ${powerShellLiteral(processName)}
$parentProcessId = ${options.currentProcessId}
$logPath = ${powerShellLiteral(options.logPath)}

function Write-UpdateRestartLog([string]$Message) {
  try {
    Add-Content -LiteralPath $logPath -Value ("[{0}] {1}" -f [DateTime]::UtcNow.ToString('o'), $Message) -Encoding UTF8
  }
  catch {
  }
}

function Get-TargetProcesses {
  return @(Get-Process -Name $targetProcessName -ErrorAction SilentlyContinue | Where-Object {
    try {
      [string]::Equals(
        [System.IO.Path]::GetFullPath($_.Path),
        [System.IO.Path]::GetFullPath($targetExecutable),
        [System.StringComparison]::OrdinalIgnoreCase
      )
    }
    catch {
      $false
    }
  })
}

try {
  Write-UpdateRestartLog "Waiting for Tessel process $parentProcessId to exit."
  $exitDeadline = [DateTime]::UtcNow.AddSeconds(90)
  do {
    $parentStillRunning = $null -ne (Get-Process -Id $parentProcessId -ErrorAction SilentlyContinue)
    $targetProcesses = @(Get-TargetProcesses)
    if (-not $parentStillRunning -and $targetProcesses.Count -eq 0) {
      break
    }
    Start-Sleep -Milliseconds 250
  } while ([DateTime]::UtcNow -lt $exitDeadline)

  if ($parentStillRunning -or $targetProcesses.Count -gt 0) {
    throw 'Tessel did not exit before the update timeout.'
  }

  Write-UpdateRestartLog "Installing from $installerPath into $installDirectory."
  $installerArguments = @('--updated', '/S', ("/D=" + $installDirectory))
  $installerProcess = Start-Process -FilePath $installerPath -ArgumentList $installerArguments -WindowStyle Hidden -Wait -PassThru
  if ($installerProcess.ExitCode -ne 0) {
    throw "The update installer exited with code $($installerProcess.ExitCode)."
  }

  $fileDeadline = [DateTime]::UtcNow.AddSeconds(20)
  while (-not (Test-Path -LiteralPath $targetExecutable -PathType Leaf) -and [DateTime]::UtcNow -lt $fileDeadline) {
    Start-Sleep -Milliseconds 250
  }
  if (-not (Test-Path -LiteralPath $targetExecutable -PathType Leaf)) {
    throw "The updated executable was not found at $targetExecutable."
  }

  Write-UpdateRestartLog "Update complete. Starting $targetExecutable."
  Start-Process -FilePath $targetExecutable -WorkingDirectory $installDirectory
}
catch {
  Write-UpdateRestartLog ("Update restart failed: " + $_.Exception.Message)
  if (Test-Path -LiteralPath $targetExecutable -PathType Leaf) {
    Start-Process -FilePath $targetExecutable -WorkingDirectory $installDirectory
  }
  exit 1
}
`;
}

function validateOptions(options: WindowsUpdateHelperOptions): void {
  if (!Number.isInteger(options.currentProcessId) || options.currentProcessId <= 0) {
    throw new Error('The current Tessel process id is invalid.');
  }
  for (const [label, path] of [
    ['update installer', options.installerPath],
    ['install directory', options.installDirectory],
    ['target executable', options.targetExecutablePath],
    ['restart log', options.logPath]
  ] as const) {
    if (!isAbsolute(path) || /[\r\n]/.test(path)) {
      throw new Error(`The ${label} path is invalid.`);
    }
  }
  if (extname(options.installerPath).toLowerCase() !== '.exe' || !existsSync(options.installerPath)) {
    throw new Error('The downloaded Windows update installer is missing.');
  }
}

function powerShellLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
