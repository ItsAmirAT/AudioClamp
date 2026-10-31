# AudioClamp

AudioClamp is a Windows real-time audio peak limiter and dynamic range controller for competitive gaming and hearing protection, providing sub-millisecond WASAPI session and master limiting.

## Tech Stack
- **Runtime**: Python 3.12+ (Windows x86_64)
- **Audio API**: CoreAudio WASAPI, MMCSS Pro Audio, `pycaw`, `comtypes`
- **GUI**: `pywebview` (Edge WebView2) + HTML5, CSS3, Vanilla JS Canvas visualizer
- **Packaging**: PyInstaller standalone executable builder

## Key Commands
- **Run Source**: `python main.py`
- **Syntax Validation**: `python -m compileall .` and `node -c ui/web/app.js`
- **Build Executable**: `python build_exe.py`
- **Install Locally**: `powershell -ExecutionPolicy Bypass -File Install-AudioClamp.ps1`
- **Check Mutex**: `powershell -Command "try { [System.Threading.Mutex]::OpenExisting('AudioClamp_SingleInstance_Mutex_391827'); 'HELD' } catch { 'FREE' }"`

## Critical Conventions
- **Single-Instance Mutex**: Process ownership uses `AudioClamp_SingleInstance_Mutex_391827`. Always verify the mutex is FREE before/after tasks; never leave hanging processes when building.
- **Limiter DSP Invariants**:
  - Attack phase only engages when downward attenuation is required (`target_att < current_att`). Never increase gain in the attack branch.
  - Release phase uses two-stage exponential decay: at the 40 ms floor while more than 3 dB of reduction remains, then `max(0.040, release_ms / 1000.0)` for the last 3 dB. The time constant never drops below 40 ms. An adaptive 25–38ms transient hold (`release_ms / 3500`) prevents gunshot echo surges and overlapping sound disruption.
  - Tactical shooter profiles (PUBG, CS2, Tarkov) enforce a 4:1 soft-knee ratio with 5.0 dB knee width to preserve acoustic distance perception.
  - Hearing-Safe mode (`hearing_safe`, opt-in, off by default) is the only sanctioned override of the two rules above: it swaps the knee for a hard cap at the ceiling, replaces the adaptive hold with a 150 ms combat hold, and disables the fast release stage.
  - Windows refreshes per-session peak meters only about every 28 ms (measured on PUBG). The first crack of any transient always passes before a volume-based clamp lands; never claim otherwise in UI copy.
- **Windows COM Lifecycles**:
  - Background worker threads must invoke `CoInitializeEx(COINIT_MULTITHREADED)` and catch `OSError` if already initialized.
  - Default audio endpoint switching routes via native `IPolicyConfig` (`CLSID_PolicyConfigClient` / `IID_IPolicyConfig`).
- **Webview Bridge**:
  - Python methods exposed to UI must reside on `JsApi` in `ui/webview_window.py`.
  - UI invokes backend asynchronously via `window.pywebview.api.<method>()`.
- **Content Integrity**:
  - Maintain documentation integrity without robotic phrasing, model metadata, or social hashtags in code comments, commits, or documentation.

## Pointers to Detailed Docs
- Audio Engine & DSP loop: `core/audio_engine.py`
- Profiles & Persistent Configuration: `core/config_manager.py`
- Desktop Window & Native API Bridge: `ui/webview_window.py`
- Visualizer & Frontend Interactions: `ui/web/app.js`
- UI Markup & Setting Manual Modal: `ui/web/index.html`
- Styles & Responsive Themes: `ui/web/style.css`
- Windows Installer Script: `Install-AudioClamp.ps1`
