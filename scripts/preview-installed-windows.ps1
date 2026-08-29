[CmdletBinding()]
param(
    [string]$InstallDir = 'D:\apps\Tessel',
    [switch]$Watch,
    [switch]$NoLaunch,
    [ValidateRange(250, 10000)]
    [int]$DebounceMilliseconds = 900
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$installRoot = (Resolve-Path -LiteralPath $InstallDir).Path
$installedExe = Join-Path $installRoot 'Tessel.exe'
$installedResources = Join-Path $installRoot 'resources'
$installedAsar = Join-Path $installedResources 'app.asar'
$installedUnpacked = Join-Path $installedResources 'app.asar.unpacked'
$previewOutput = Join-Path $projectRoot 'dist-preview'
$previewResources = Join-Path $previewOutput 'resources'
$previewAsar = Join-Path $previewResources 'app.asar'
$previewUnpacked = Join-Path $previewResources 'app.asar.unpacked'
$previewStaging = Join-Path $previewOutput 'app-staging'
$backupRoot = Join-Path $installedResources 'preview-backups'
$sessionBackupDir = $null

$typeScript = Join-Path $projectRoot 'node_modules\.bin\tsc.cmd'
$electronVite = Join-Path $projectRoot 'node_modules\.bin\electron-vite.cmd'
$nodeCommand = (Get-Command 'node.exe' -ErrorAction Stop).Source
$asarCli = Get-ChildItem -LiteralPath (Join-Path $projectRoot 'node_modules\.pnpm') -Recurse -File -Filter 'asar.js' |
    Where-Object { $_.FullName -match '@electron[\\/]asar[\\/]bin[\\/]asar\.js$' } |
    Select-Object -First 1 -ExpandProperty FullName

function Assert-File([string]$Path, [string]$Description) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "$Description was not found: $Path"
    }
}

function Invoke-CheckedCommand([string]$Command, [string[]]$Arguments) {
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Command failed with exit code $LASTEXITCODE`: $Command $($Arguments -join ' ')"
    }
}

function Get-InstalledTesselProcesses {
    $expectedPath = [System.IO.Path]::GetFullPath($installedExe)

    return @(Get-Process -Name 'Tessel' -ErrorAction SilentlyContinue | Where-Object {
        try {
            [string]::Equals(
                [System.IO.Path]::GetFullPath($_.Path),
                $expectedPath,
                [System.StringComparison]::OrdinalIgnoreCase
            )
        }
        catch {
            $false
        }
    })
}

function Stop-InstalledTessel {
    $processes = @(Get-InstalledTesselProcesses)
    if ($processes.Count -eq 0) {
        return
    }

    Write-Host "Stopping installed Tessel ($($processes.Count) processes)..." -ForegroundColor Cyan

    foreach ($process in $processes) {
        try {
            [void]$process.CloseMainWindow()
        }
        catch {
            # Renderer/helper processes do not own a window.
        }
    }

    $deadline = [DateTime]::UtcNow.AddSeconds(8)
    do {
        Start-Sleep -Milliseconds 200
        $remaining = @(Get-InstalledTesselProcesses)
    } while ($remaining.Count -gt 0 -and [DateTime]::UtcNow -lt $deadline)

    foreach ($process in $remaining) {
        Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    }

    if ($remaining.Count -gt 0) {
        Start-Sleep -Milliseconds 300
    }
}

function Copy-DirectoryContents([string]$Source, [string]$Destination) {
    if (-not (Test-Path -LiteralPath $Destination -PathType Container)) {
        [void](New-Item -ItemType Directory -Path $Destination -Force)
    }

    Get-ChildItem -LiteralPath $Source -Force | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination $Destination -Recurse -Force
    }
}

function Copy-PreviewRuntimeDependency([string]$PackageName) {
    $source = Join-Path (Join-Path $projectRoot 'node_modules') $PackageName
    $destination = Join-Path (Join-Path $previewStaging 'node_modules') $PackageName
    if (-not (Test-Path -LiteralPath $source -PathType Container)) {
        throw "Runtime dependency was not installed: $PackageName"
    }
    $destinationParent = Split-Path -Parent $destination
    [void](New-Item -ItemType Directory -Path $destinationParent -Force)
    if (Test-Path -LiteralPath $destination -PathType Container) {
        Remove-Item -LiteralPath $destination -Recurse -Force
    }
    Copy-Item -LiteralPath $source -Destination $destination -Recurse -Force
}

function Build-PreviewPackage {
    Write-Host 'Type-checking...' -ForegroundColor Cyan
    Invoke-CheckedCommand $typeScript @('-b', '--noEmit')

    Write-Host 'Building renderer and main process...' -ForegroundColor Cyan
    Invoke-CheckedCommand $electronVite @('build')

    Write-Host 'Preparing preview app from the installed package...' -ForegroundColor Cyan
    if (Test-Path -LiteralPath $previewStaging -PathType Container) {
        Remove-Item -LiteralPath $previewStaging -Recurse -Force
    }
    [void](New-Item -ItemType Directory -Path $previewStaging -Force)
    Invoke-CheckedCommand $nodeCommand @($asarCli, 'extract', $installedAsar, $previewStaging)

    $stagedOut = Join-Path $previewStaging 'out'
    if (Test-Path -LiteralPath $stagedOut -PathType Container) {
        Remove-Item -LiteralPath $stagedOut -Recurse -Force
    }
    Copy-Item -LiteralPath (Join-Path $projectRoot 'out') -Destination $previewStaging -Recurse -Force

    Copy-Item -LiteralPath (Join-Path $projectRoot 'package.json') -Destination (Join-Path $previewStaging 'package.json') -Force

    # Preview installs are based on the currently installed asar. Copy runtime
    # packages introduced by this source tree so externalized main-process
    # imports are available before the next full installer is produced.
    Copy-PreviewRuntimeDependency 'ws'

    $iconSource = Join-Path $projectRoot 'src\assets\icons\icon_256x256.png'
    if (Test-Path -LiteralPath $iconSource -PathType Leaf) {
        $iconDestination = Join-Path $previewStaging 'src\assets\icons'
        [void](New-Item -ItemType Directory -Path $iconDestination -Force)
        Copy-Item -LiteralPath $iconSource -Destination (Join-Path $iconDestination 'icon_256x256.png') -Force
    }

    [void](New-Item -ItemType Directory -Path $previewResources -Force)
    if (Test-Path -LiteralPath $previewAsar -PathType Leaf) {
        Remove-Item -LiteralPath $previewAsar -Force
    }
    if (Test-Path -LiteralPath $previewUnpacked -PathType Container) {
        Remove-Item -LiteralPath $previewUnpacked -Recurse -Force
    }

    Write-Host 'Packing preview app.asar...' -ForegroundColor Cyan
    try {
        Invoke-CheckedCommand $nodeCommand @(
            $asarCli,
            'pack',
            $previewStaging,
            $previewAsar,
            '--unpack-dir',
            'node_modules/@esbuild/win32-x64'
        )
    }
    finally {
        if (Test-Path -LiteralPath $previewStaging -PathType Container) {
            Remove-Item -LiteralPath $previewStaging -Recurse -Force
        }
    }

    Assert-File $previewAsar 'Packaged app.asar'
}

function Install-PreviewPackage {
    Stop-InstalledTessel

    if ($null -eq $script:sessionBackupDir) {
        $timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
        $script:sessionBackupDir = Join-Path $backupRoot $timestamp
        [void](New-Item -ItemType Directory -Path $script:sessionBackupDir -Force)

        Copy-Item -LiteralPath $installedAsar -Destination (Join-Path $script:sessionBackupDir 'app.asar') -Force

        if (Test-Path -LiteralPath $installedUnpacked -PathType Container) {
            Copy-Item -LiteralPath $installedUnpacked -Destination $script:sessionBackupDir -Recurse -Force
        }
    }

    $backupAsar = Join-Path $script:sessionBackupDir 'app.asar'

    $temporaryAsar = Join-Path $installedResources "app.asar.preview-$PID.tmp"
    Copy-Item -LiteralPath $previewAsar -Destination $temporaryAsar -Force

    try {
        Copy-Item -LiteralPath $temporaryAsar -Destination $installedAsar -Force
        Remove-Item -LiteralPath $temporaryAsar -Force

        if (Test-Path -LiteralPath $previewUnpacked -PathType Container) {
            Copy-DirectoryContents $previewUnpacked $installedUnpacked
        }
    }
    catch {
        if (Test-Path -LiteralPath $temporaryAsar -PathType Leaf) {
            Remove-Item -LiteralPath $temporaryAsar -Force
        }

        Copy-Item -LiteralPath $backupAsar -Destination $installedAsar -Force

        if (-not $NoLaunch) {
            Start-Process -FilePath $installedExe -WorkingDirectory $installRoot
        }
        throw
    }

    Write-Host "Installed preview build. Backup: $script:sessionBackupDir" -ForegroundColor Green

    if (-not $NoLaunch) {
        Write-Host 'Starting Tessel...' -ForegroundColor Cyan
        Start-Process -FilePath $installedExe -WorkingDirectory $installRoot
    }
}

function Publish-Preview {
    Push-Location $projectRoot
    try {
        Build-PreviewPackage
        Install-PreviewPackage
    }
    finally {
        Pop-Location
    }
}

function Get-WatchedState {
    $watchedFiles = @(
        Get-ChildItem -LiteralPath (Join-Path $projectRoot 'src') -File -Recurse
        Get-ChildItem -LiteralPath $projectRoot -File | Where-Object {
            $_.Name -eq 'package.json' -or
            $_.Name -eq 'electron.vite.config.ts' -or
            $_.Name -like 'tsconfig*.json'
        }
    )

    return (($watchedFiles |
        Sort-Object FullName |
        ForEach-Object { "$($_.FullName)|$($_.LastWriteTimeUtc.Ticks)|$($_.Length)" }) -join "`n")
}

Assert-File $installedExe 'Installed Tessel executable'
Assert-File $installedAsar 'Installed app.asar'
Assert-File $typeScript 'Local TypeScript compiler'
Assert-File $electronVite 'Local electron-vite command'
Assert-File $nodeCommand 'Node.js executable'
Assert-File $asarCli 'Local asar packer'

Publish-Preview

if (-not $Watch) {
    exit 0
}

Write-Host 'Watching source files. Press Ctrl+C to stop.' -ForegroundColor Yellow
$previousState = Get-WatchedState

while ($true) {
    Start-Sleep -Milliseconds 500
    $currentState = Get-WatchedState
    if ($currentState -eq $previousState) {
        continue
    }

    do {
        Start-Sleep -Milliseconds $DebounceMilliseconds
        $settledState = Get-WatchedState
        $changedAgain = $settledState -ne $currentState
        $currentState = $settledState
    } while ($changedAgain)

    try {
        Publish-Preview
        $previousState = $currentState
        Write-Host 'Watching source files. Press Ctrl+C to stop.' -ForegroundColor Yellow
    }
    catch {
        Write-Host "Preview update failed: $($_.Exception.Message)" -ForegroundColor Red
        $previousState = $currentState
        Write-Host 'The installed app was left on the last working build. Watching for more changes...' -ForegroundColor Yellow
    }
}
