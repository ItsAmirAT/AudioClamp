---
paths:
  - "tests/**"
  - "test_*.py"
  - "*_test.py"
  - "core/audio_engine.py"
  - "main.py"
  - "build_exe.py"
---

# Testing & Verification Guide

## Static Syntax & Compilation Checks
Always run these fast checks before any commit or build:
```powershell
# Python byte-compilation check across all modules
python -m compileall .

# Frontend JavaScript syntax validation
node -c ui/web/app.js
```

## Single-Instance Mutex Validation
The engine registers a system-wide named mutex `AudioClamp_SingleInstance_Mutex_391827` to prevent multiple audio loopback hooks.
Verify mutex state:
```powershell
powershell -Command "try { $m = [System.Threading.Mutex]::OpenExisting('AudioClamp_SingleInstance_Mutex_391827'); 'Mutex is HELD' } catch { 'Mutex is FREE' }"
```
- If HELD when no app should be active: Run `Stop-Process -Name AudioClamp -Force` before running builds or tests.
- After tests: Ensure mutex returns to `FREE`.

## Headless Audio Engine Verification
Test the DSP math without launching the GUI:
```python
from core.config_manager import ConfigManager
from core.audio_engine import AudioEngine

config = ConfigManager()
engine = AudioEngine(config)

# Verify soft-knee 4:1 attenuation curve
# Input peak 0.70 (-3 dB) with -12 dB threshold must yield attenuation
att, gr_db = engine._compute_soft_knee_attenuation(0.70, -12.0, "soft_knee", 5.0, 4.0)
assert att < 1.0, "Limiter must attenuate signals exceeding threshold"
assert gr_db < 0.0, "Gain reduction must be negative decibels"

# Verify silent signals pass unaffected
att_silent, gr_silent = engine._compute_soft_knee_attenuation(0.00001, -12.0, "soft_knee", 5.0, 4.0)
assert att_silent == 1.0 and gr_silent == 0.0, "Silence must produce 0 dB reduction"
```

## Build & Package Verification
Run standalone compilation and inspect the resulting executable:
```powershell
python build_exe.py
Test-Path "dist\AudioClamp.exe"
```
Verify the output binary executes cleanly and terminates on signal without leaving orphaned background threads.
