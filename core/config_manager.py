import os
import json
import winreg
from typing import Dict, Any

APPDATA_DIR = os.path.join(os.environ.get("LOCALAPPDATA", os.path.expanduser("~")), "AudioClamp")
CONFIG_PATH = os.path.join(APPDATA_DIR, "config.json")
RECOVERY_PATH = os.path.join(APPDATA_DIR, "recovery.json")

GAME_PROFILES: Dict[str, Dict[str, Any]] = {
    "PUBG: BATTLEGROUNDS": {
        "exe_names": ["TslGame.exe"],
        "threshold_db": -12.0,
        "knee_mode": "soft_knee",
        "knee_width_db": 6.0,
        "compression_ratio": 4.0,
        "attack_ms": 2,
        "release_ms": 120,
        "stereo_linked": True,
        "description": "Reduces loud gunfire spikes while keeping footstep cues audible."
    },
    "Escape from Tarkov": {
        "exe_names": ["EscapeFromTarkov.exe", "EscapeFromTarkov_BE.exe"],
        "threshold_db": -10.0,
        "knee_mode": "soft_knee",
        "knee_width_db": 5.0,
        "compression_ratio": 3.5,
        "attack_ms": 1,
        "release_ms": 100,
        "stereo_linked": True,
        "description": "Protects against sudden grenade concussions and close fire."
    },
    "Counter-Strike 2": {
        "exe_names": ["cs2.exe"],
        "threshold_db": -8.0,
        "knee_mode": "soft_knee",
        "knee_width_db": 4.0,
        "compression_ratio": 4.0,
        "attack_ms": 2,
        "release_ms": 80,
        "stereo_linked": True,
        "description": "Controls AWP and flashbang spikes with fast footstep recovery."
    },
    "Call of Duty / Warzone": {
        "exe_names": ["cod.exe", "bootstrapper.exe"],
        "threshold_db": -14.0,
        "knee_mode": "soft_knee",
        "knee_width_db": 6.0,
        "compression_ratio": 4.0,
        "attack_ms": 2,
        "release_ms": 150,
        "stereo_linked": True,
        "description": "Levels precision airstrikes and vehicle noise."
    },
    "Valorant": {
        "exe_names": ["VALORANT-Win64-Shipping.exe", "Valorant.exe"],
        "threshold_db": -9.0,
        "knee_mode": "soft_knee",
        "knee_width_db": 4.0,
        "compression_ratio": 4.0,
        "attack_ms": 1,
        "release_ms": 90,
        "stereo_linked": True,
        "description": "Tames Operator snipers and heavy ultimate abilities."
    },
    "Apex Legends": {
        "exe_names": ["r5apex.exe", "r5apex_dx12.exe"],
        "threshold_db": -11.0,
        "knee_mode": "soft_knee",
        "knee_width_db": 6.0,
        "compression_ratio": 3.5,
        "attack_ms": 2,
        "release_ms": 130,
        "stereo_linked": True,
        "description": "Caps airstrikes and artillery explosions while preserving spatial sliding sounds."
    },
    "Cinema / Movie Night": {
        "exe_names": ["vlc.exe", "mpc-hc64.exe", "PotPlayer64.exe"],
        "threshold_db": -15.0,
        "knee_mode": "brickwall",
        "knee_width_db": 2.0,
        "compression_ratio": 20.0,
        "attack_ms": 5,
        "release_ms": 600,
        "stereo_linked": True,
        "description": "Balances explosive cinematic action with quiet dialogue scenes."
    },
    "Late Night (Whisper)": {
        "exe_names": [],
        "threshold_db": -20.0,
        "knee_mode": "brickwall",
        "knee_width_db": 1.0,
        "compression_ratio": 50.0,
        "attack_ms": 2,
        "release_ms": 800,
        "stereo_linked": True,
        "description": "Maximum ceiling protection for quiet nighttime listening."
    }
}

DEFAULT_CONFIG: Dict[str, Any] = {
    "enabled": True,
    "auto_watch_mode": True,
    "target_mode": "auto_game",
    "target_process": "",
    "monitored_apps": [
        "TslGame.exe",
        "EscapeFromTarkov.exe",
        "EscapeFromTarkov_BE.exe",
        "cs2.exe",
        "cod.exe",
        "bootstrapper.exe",
        "VALORANT-Win64-Shipping.exe",
        "Valorant.exe",
        "r5apex.exe",
        "r5apex_dx12.exe"
    ],
    "threshold_db": -12.0,
    "threshold_percent": 50.0,
    "knee_mode": "soft_knee",
    "knee_width_db": 6.0,
    "compression_ratio": 4.0,
    "attack_ms": 2,
    "release_ms": 120,
    "stereo_linked": True,
    "selected_profile": "PUBG: BATTLEGROUNDS",
    "dark_mode": True,
    "start_with_windows": False,
    "start_minimized": False,
    "hotkey_toggle": "ctrl+alt+l",
    "hotkey_emergency_reset": "ctrl+alt+r",
}

class ConfigManager:
    def __init__(self):
        os.makedirs(APPDATA_DIR, exist_ok=True)
        self.config: Dict[str, Any] = self.load_config()
        self._cleanup_legacy_registry()

    def _cleanup_legacy_registry(self):
        key_path = r"Software\Microsoft\Windows\CurrentVersion\Run"
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, key_path, 0, winreg.KEY_SET_VALUE) as key:
                try:
                    winreg.DeleteValue(key, "SoundLockPro")
                except FileNotFoundError:
                    pass
        except Exception:
            pass

    def load_config(self) -> Dict[str, Any]:
        if os.path.exists(CONFIG_PATH):
            try:
                with open(CONFIG_PATH, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    cfg = DEFAULT_CONFIG.copy()
                    cfg.update(data)
                    return cfg
            except Exception as e:
                print(f"[ConfigManager] Could not read configuration file: {e}")
        return DEFAULT_CONFIG.copy()

    def save_config(self):
        try:
            with open(CONFIG_PATH, "w", encoding="utf-8") as f:
                json.dump(self.config, f, indent=4)
        except Exception as e:
            print(f"[ConfigManager] Could not save configuration file: {e}")

    def get(self, key: str, default=None):
        return self.config.get(key, default)

    def set(self, key: str, value: Any, save: bool = True):
        self.config[key] = value
        if save:
            self.save_config()

    def apply_profile(self, profile_name: str):
        if profile_name in GAME_PROFILES:
            p = GAME_PROFILES[profile_name]
            self.config["threshold_db"] = p["threshold_db"]
            scalar = 10.0 ** (p["threshold_db"] / 20.0)
            self.config["threshold_percent"] = max(5.0, min(100.0, scalar * 100.0))
            self.config["knee_mode"] = p["knee_mode"]
            self.config["knee_width_db"] = p["knee_width_db"]
            self.config["compression_ratio"] = p["compression_ratio"]
            self.config["attack_ms"] = p["attack_ms"]
            self.config["release_ms"] = p["release_ms"]
            self.config["stereo_linked"] = p["stereo_linked"]
            self.config["selected_profile"] = profile_name
            self.save_config()

    def add_monitored_app(self, exe_name: str):
        clean = os.path.basename(str(exe_name).strip())
        if clean:
            apps = list(self.config.get("monitored_apps", []))
            if not any(a.lower() == clean.lower() for a in apps):
                apps.append(clean)
                self.config["monitored_apps"] = apps
                self.save_config()

    def remove_monitored_app(self, exe_name: str):
        clean = str(exe_name).strip().lower()
        apps = [a for a in self.config.get("monitored_apps", []) if a.lower() != clean]
        self.config["monitored_apps"] = apps
        self.save_config()

    def save_recovery_state(self, target_type: str, target_name: str, original_volume: float):
        try:
            state = {
                "target_type": target_type,
                "target_name": target_name,
                "original_volume": original_volume
            }
            with open(RECOVERY_PATH, "w", encoding="utf-8") as f:
                json.dump(state, f, indent=4)
        except Exception:
            pass

    def clear_recovery_state(self):
        try:
            if os.path.exists(RECOVERY_PATH):
                os.remove(RECOVERY_PATH)
        except Exception:
            pass

    def get_recovery_state(self) -> Dict[str, Any] | None:
        if os.path.exists(RECOVERY_PATH):
            try:
                with open(RECOVERY_PATH, "r", encoding="utf-8") as f:
                    return json.load(f)
            except Exception:
                pass
        return None

    def set_start_with_windows(self, enabled: bool, app_path: str):
        self.set("start_with_windows", enabled)
        key_path = r"Software\Microsoft\Windows\CurrentVersion\Run"
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, key_path, 0, winreg.KEY_SET_VALUE) as key:
                try:
                    winreg.DeleteValue(key, "SoundLockPro")
                except FileNotFoundError:
                    pass

                if enabled:
                    winreg.SetValueEx(key, "AudioClamp", 0, winreg.REG_SZ, f'"{app_path}" --minimized')
                else:
                    try:
                        winreg.DeleteValue(key, "AudioClamp")
                    except FileNotFoundError:
                        pass
        except Exception as e:
            print(f"[ConfigManager] Could not update Windows startup registry: {e}")
