---
paths:
  - "main.py"
  - "core/**"
  - "ui/**"
  - "build_exe.py"
  - "Install-AudioClamp.ps1"
---

# Architecture & Module Boundaries

## System Overview
AudioClamp is organized into three decoupled layers:
1. **Core Layer (`core/`)**: Headless DSP calculation, Windows WASAPI metering, and configuration management.
2. **Bridge Layer (`ui/webview_window.py`)**: Inter-process bridge, system tray manager, and native window hooks.
3. **Presentation Layer (`ui/web/`)**: HTML5/CSS3/Canvas user interface executed inside Microsoft Edge WebView2.

```
┌────────────────────────────────────────────────────────┐
│               Edge WebView2 (ui/web/)                 │
│      Canvas Visualizer · Settings Guide · Controls     │
└──────────────────────────┬─────────────────────────────┘
                           │ window.pywebview.api (Async JSON)
┌──────────────────────────▼─────────────────────────────┐
│          Bridge Layer (ui/webview_window.py)           │
│     JsApi RPC · System Tray (pystray) · Win32 HWND     │
└──────────────┬──────────────────────────┬──────────────┘
               │                          │
┌──────────────▼────────────┐ ┌───────────▼──────────────┐
│   core/audio_engine.py    │ │  core/config_manager.py  │
│  WASAPI 333 Hz Loopback   │ │  JSON Settings Store     │
│  MMCSS "Pro Audio" Thread │ │  Game Profiles & Presets │
│  DSP Limiter & Knee Math  │ │  Windows Startup Registry│
│  IPolicyConfig Endpoints  │ │                          │
└───────────────────────────┘ └──────────────────────────┘
```

## Module Boundaries & Invariants
- **Headless Core**: `core/audio_engine.py` and `core/config_manager.py` must NEVER import anything from `ui/` or `webview`. The core audio engine must remain fully functional in headless environments.
- **Thread Boundaries**:
  - Main Thread: Owns the WebView2 window loop and Win32 message pump.
  - Limiter Worker Thread: Runs independently in high-priority MMCSS ("Pro Audio") mode at 333 Hz.
  - Telemetry updates from worker to main thread flow through `telemetry_callback` into `window.evaluate_js` with a 50ms throttle.
- **Volume Clamping Isolation**:
  - `auto_game` and `specific_app` target modes clamp individual process sessions (`ISimpleAudioVolume`). Master PC audio, Discord, and system alerts remain bit-perfect and uncompressed.
  - `master_device` clamps the global endpoint (`IAudioEndpointVolume`) using a custom GUID context to prevent feedback loops with manual user volume adjustments.
