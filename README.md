# AudioClamp

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-Windows%2010%20%2F%2011-0078D6.svg)](https://microsoft.com/windows)
[![Ko-fi](https://img.shields.io/badge/Ko--fi-Support%20Development-FF5E5B?style=for-the-badge&logo=ko-fi&logoColor=white)](https://ko-fi.com/itsspero)

**AudioClamp** is a real-time, hardware-accelerated Windows audio limiter designed for competitive esports, gaming, and cinema. It dynamically clamps deafening audio spikes (point-blank gunshots, red zones, flashbangs, grenade concussions) while preserving quiet audio details like enemy footsteps and teammate voice communications.

Unlike legacy utilities that pull down the global Windows volume slider across the entire system, AudioClamp utilizes Windows Core Audio (WASAPI) session routing and soft-knee compression dynamics.

---

## ☕ Support the Project

If AudioClamp saved your ears during gaming sessions or late-night movie watching, consider supporting future development:

[![Support on Ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/itsspero)

Your support helps fund continuous updates, new game calibration profiles, and driver compatibility testing.

---

## ✨ Features

- **Auto-Game Watcher Service**: Automatically detects when games launch. While on desktop or web browsing, AudioClamp stays in a zero-overhead standby mode leaving system volume 100% raw. When a monitored game opens, clamping engages instantly; when the game exits, volume is seamlessly restored to 100%.
- **Custom Game & App Management**: Add or remove any application or `.exe` with 1 click via interactive process scanning or file browser.
- **Per-Application Audio Limiting**: Lock the limiter to specific games (e.g. `TslGame.exe`, `cs2.exe`, `EscapeFromTarkov.exe`). Discord, TeamSpeak, and music players remain untouched at full volume.
- **Stereo-Linked Balance (HRTF Safe)**: Both stereo channels share unified peak detection. Directional spatial audio cues and stereo panning remain 100% accurate.
- **Soft-Knee Distance Preservation**: A gradual 4:1 compression curve prevents close shots and distant sniper fire from clamping to the exact same loudness, preserving distance judgment.
- **Pop-Free Slew Attack & Hold Dynamics**: Sub-4ms onset clamping stops sniper cracks without DC audio clicks. A 40ms spray hold timer eliminates volume fluttering during automatic weapon bursts.
- **Configurable Footstep Recovery**: Adjustable release times (50ms – 600ms) smoothly restore ambient game audio without audible pumping.
- **Decibel (dBFS) Precision**: Accurate visual meter calibrated from 0 dBFS down to -36 dBFS with real-time gain reduction monitoring.
- **High-Refresh Canvas UI**: Hardware-accelerated, responsive 60Hz – 240Hz visualizer with Per-Monitor V2 High-DPI scaling.
- **Instant Esports Profiles**: Pre-tuned 1-click calibrations for PUBG, Escape from Tarkov, Counter-Strike 2, Call of Duty: Warzone, Valorant, Apex Legends, and Cinema.

---

## 🎮 Pre-Calibrated Profiles

| Profile | Ceiling | Release | Target Use Case |
| :--- | :--- | :--- | :--- |
| **PUBG: BATTLEGROUNDS** | `-12 dBFS` | `120 ms` | Clamps red zones & Beryl/M4 sprays; fast footstep recovery |
| **Escape from Tarkov** | `-10 dBFS` | `100 ms` | Concussion & close firefight protection; bush/wood movement clarity |
| **Counter-Strike 2** | `-8 dBFS` | `80 ms` | Controls AWP cracks and flashbang ringing with instant recovery |
| **Call of Duty / Warzone** | `-14 dBFS` | `150 ms` | Levels precision airstrikes, cluster strikes, and vehicle noise |
| **Valorant** | `-9 dBFS` | `90 ms` | Caps Operator sniper shots and heavy ultimate abilities |
| **Apex Legends** | `-11 dBFS` | `130 ms` | Tames Gibraltar/Bangalore ultimate explosions and supply ship noise |
| **Cinema / Movie Night** | `-15 dBFS` | `600 ms` | Smooths explosive action scenes while keeping dialogue clear |
| **Late Night (Whisper)** | `-20 dBFS` | `800 ms` | Maximum ceiling protection for quiet nighttime listening |

---

## ⌨️ Global Hotkeys

- **`Ctrl + Alt + L`**: Toggle AudioClamp Limiter ON / OFF in-game.
- **`Ctrl + Alt + R`**: Emergency Volume Reset (instantly restores audio volumes to 100%).

---

## 📦 Building from Source

### Prerequisites
- Python 3.10+
- Windows 10 or Windows 11

### Setup
```bash
# Clone the repository
git clone git@github.com:ItsAmirAT/AudioClamp.git
cd AudioClamp

# Install dependencies
pip install -r requirements.txt

# Run directly
python main.py
```

### Compile Standalone Executable
```bash
python build_exe.py
```
The compiled single-file binary will be generated at `dist/AudioClamp.exe`.

---

## 📄 License

Distributed under the [MIT License](LICENSE).
