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

# Stop any running instance before updating
Get-Process -Name $AppName -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 600

$TargetExe = Join-Path $InstallDir "$AppName.exe"
Copy-Item -Path $SourceExe -Destination $TargetExe -Force
Unblock-File -Path $TargetExe -ErrorAction SilentlyContinue

# Ensure clean automatic Windows startup (remove legacy entries and set AudioClamp)
Remove-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" -Name "SoundLockPro" -ErrorAction SilentlyContinue
Set-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" -Name "AudioClamp" -Value "`"$TargetExe`" --minimized"

# Create Desktop Shortcut
$WshShell = New-Object -ComObject WScript.Shell
$DesktopPath = [Environment]::GetFolderPath("Desktop")
$DesktopShortcut = $WshShell.CreateShortcut((Join-Path $DesktopPath "$AppName.lnk"))
$DesktopShortcut.TargetPath = $TargetExe
$DesktopShortcut.WorkingDirectory = $InstallDir
$DesktopShortcut.Description = "AudioClamp - Studio Peak Limiter"
$DesktopShortcut.Save()
Unblock-File -Path (Join-Path $DesktopPath "$AppName.lnk") -ErrorAction SilentlyContinue

# Create Start Menu Shortcut
$StartMenuPath = [Environment]::GetFolderPath("Programs")
$StartShortcut = $WshShell.CreateShortcut((Join-Path $StartMenuPath "$AppName.lnk"))
$StartShortcut.TargetPath = $TargetExe
$StartShortcut.WorkingDirectory = $InstallDir
$StartShortcut.Description = "AudioClamp - Studio Peak Limiter"
$StartShortcut.Save()
Unblock-File -Path (Join-Path $StartMenuPath "$AppName.lnk") -ErrorAction SilentlyContinue

Write-Host "Installation completed successfully!" -ForegroundColor Green
Write-Host "Installed to: $TargetExe" -ForegroundColor Yellow
Write-Host "Desktop shortcut created: $DesktopPath\$AppName.lnk" -ForegroundColor Yellow
