# AudioClamp One-Click Windows Installer Script
$ErrorActionPreference = "Stop"

$AppName = "AudioClamp"
$ProjectDir = $PSScriptRoot
$SourceExe = Join-Path $ProjectDir "dist\AudioClamp.exe"

if (-not (Test-Path $SourceExe)) {
    Write-Host "Compiling AudioClamp..." -ForegroundColor Cyan
    python (Join-Path $ProjectDir "build_exe.py")
}

$InstallDir = Join-Path $env:LOCALAPPDATA "Programs\$AppName"
if (-not (Test-Path $InstallDir)) {
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
}

$TargetExe = Join-Path $InstallDir "$AppName.exe"
Copy-Item -Path $SourceExe -Destination $TargetExe -Force

# Create Desktop Shortcut
$WshShell = New-Object -ComObject WScript.Shell
$DesktopPath = [Environment]::GetFolderPath("Desktop")
$DesktopShortcut = $WshShell.CreateShortcut((Join-Path $DesktopPath "$AppName.lnk"))
$DesktopShortcut.TargetPath = $TargetExe
$DesktopShortcut.WorkingDirectory = $InstallDir
$DesktopShortcut.Description = "AudioClamp - Studio Peak Limiter"
$DesktopShortcut.Save()

# Create Start Menu Shortcut
$StartMenuPath = [Environment]::GetFolderPath("Programs")
$StartShortcut = $WshShell.CreateShortcut((Join-Path $StartMenuPath "$AppName.lnk"))
$StartShortcut.TargetPath = $TargetExe
$StartShortcut.WorkingDirectory = $InstallDir
$StartShortcut.Description = "AudioClamp - Studio Peak Limiter"
$StartShortcut.Save()

Write-Host "Installation completed successfully!" -ForegroundColor Green
Write-Host "Installed to: $TargetExe" -ForegroundColor Yellow
Write-Host "Desktop shortcut created: $DesktopPath\$AppName.lnk" -ForegroundColor Yellow
