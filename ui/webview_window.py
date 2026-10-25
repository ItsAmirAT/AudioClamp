import os
import sys
import json
import time
import threading
import webbrowser
import webview
from typing import Optional, Dict, Any

from core.config_manager import ConfigManager
from core.audio_engine import AudioEngine
from ui.tray_icon import TrayIconManager
from core.hotkeys import HotkeyManager

WEB_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "web")
INDEX_HTML = os.path.join(WEB_DIR, "index.html")

class WebviewApi:
    def __init__(self, app_window: "WebviewWindow"):
        self._app = app_window

    def set_threshold(self, db_val):
        pct = (10.0 ** (float(db_val) / 20.0)) * 100.0
        self._app.config.set("threshold_db", float(db_val))
        self._app.config.set("threshold_percent", float(pct))

    def toggle_enabled(self, enabled):
        self._app.config.set("enabled", bool(enabled))
        self._app.tray_mgr.update_icon(bool(enabled))

    def set_knee_mode(self, mode):
        self._app.config.set("knee_mode", str(mode))

    def set_release_ms(self, ms):
        self._app.config.set("release_ms", float(ms))

    def set_scope(self, scope_mode):
        self._app.config.set("target_mode", str(scope_mode))
        self._app.engine.rescan_sessions_now()

    def get_audio_processes(self):
        from pycaw.pycaw import AudioUtilities
        from comtypes import CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED
        procs = set()
        try:
            CoInitializeEx(COINIT_MULTITHREADED)
            sessions = AudioUtilities.GetAllSessions()
            for s in sessions:
                p = s.Process
                if p and p.name():
                    procs.add(p.name())
            CoUninitialize()
        except Exception:
            pass
        return sorted(list(procs), key=lambda x: x.lower())

    def browse_for_exe(self):
        if not self._app.window:
            return ""
        try:
            file_types = ("Executable Files (*.exe)", "All Files (*.*)")
            res = self._app.window.create_file_dialog(
                webview.OPEN_DIALOG,
                allow_multiple=False,
                file_types=file_types
            )
            if res and len(res) > 0:
                selected_path = res[0]
                exe_name = os.path.basename(selected_path)
                self.set_custom_process(exe_name)
                return exe_name
        except Exception:
            pass
        return ""

    def set_custom_process(self, proc_name):
        name = str(proc_name).strip()
        if name:
            self._app.config.set("target_process", name)
            self._app.config.set("target_mode", "specific_app")
            self._app.engine.rescan_sessions_now()

    def apply_profile(self, profile_name):
        self._app.config.apply_profile(str(profile_name))
        cfg = self._app.config.config
        if self._app.window:
            self._app.window.evaluate_js(f"receiveInitialConfig({json.dumps(cfg)})")

    def emergency_reset(self):
        self._app.engine.emergency_reset_volume()
        self._app.config.set("threshold_db", 0.0)
        self._app.config.set("threshold_percent", 100.0)

    def move_window(self, x, y):
        if self._app.window:
            try:
                self._app.window.move(int(x), int(y))
            except Exception:
                pass

    def minimize_window(self):
        if self._app.window:
            self._app.window.minimize()

    def toggle_maximize(self):
        if self._app.window:
            try:
                if getattr(self._app, 'is_maximized', False):
                    self._app.window.restore()
                    self._app.is_maximized = False
                else:
                    self._app.window.maximize()
                    self._app.is_maximized = True
                return self._app.is_maximized
            except Exception:
                pass
        return False

    def close_window(self):
        self._app.on_full_exit()

    def open_donation_link(self):
        try:
            webbrowser.open("https://ko-fi.com/itsspero")
        except Exception:
            pass

class WebviewWindow:
    def __init__(self, config: ConfigManager, engine: AudioEngine):
        self.config = config
        self.engine = engine
        self.api = WebviewApi(self)
        self.window: Optional[webview.Window] = None
        self.is_maximized = False

        self.last_telemetry_time = 0.0
        self.telemetry_interval = 0.016

        self.hotkey_mgr = HotkeyManager(
            on_toggle=self.toggle_enable,
            on_reset=self.emergency_reset
        )
        self.hotkey_mgr.register_hotkeys(
            self.config.get("hotkey_toggle", "ctrl+alt+l"),
            self.config.get("hotkey_emergency_reset", "ctrl+alt+r")
        )

        self.tray_mgr = TrayIconManager(
            on_toggle_show=self.toggle_window_visibility,
            on_toggle_enable=self.toggle_enable,
            on_emergency_reset=self.emergency_reset,
            on_apply_preset=self.api.apply_profile,
            on_exit=self.on_full_exit,
            is_enabled_getter=lambda: self.config.get("enabled", True)
        )
        self.tray_mgr.start()

        self.engine.telemetry_callback = self._on_telemetry_data

    def toggle_enable(self):
        new_val = not self.config.get("enabled", True)
        self.api.toggle_enabled(new_val)
        if self.window:
            self.window.evaluate_js(f"document.getElementById('powerSwitch').checked = {json.dumps(new_val)}; document.getElementById('powerSwitch').dispatchEvent(new Event('change'));")

    def emergency_reset(self):
        self.api.emergency_reset()
        if self.window:
            self.window.evaluate_js("emergencyReset()")

    def toggle_window_visibility(self):
        if not self.window:
            return
        if self.window.shown:
            self.window.hide()
        else:
            self.window.show()
            self.window.restore()

    def on_full_exit(self):
        self.engine.stop()
        self.hotkey_mgr.unregister_hotkeys()
        self.tray_mgr.stop()
        if self.window:
            try:
                self.window.destroy()
            except Exception:
                pass
        sys.exit(0)

    def _on_telemetry_data(self, data: Dict[str, Any]):
        now = time.perf_counter()
        if now - self.last_telemetry_time >= self.telemetry_interval:
            self.last_telemetry_time = now
            if self.window and self.window.shown:
                try:
                    js_code = f"receiveTelemetry({json.dumps(data)});"
                    self.window.evaluate_js(js_code)
                except Exception:
                    pass

    def run(self, start_minimized: bool = False):
        self.window = webview.create_window(
            title="AudioClamp",
            url=INDEX_HTML,
            js_api=self.api,
            width=760,
            height=890,
            min_size=(680, 750),
            resizable=True,
            frameless=True,
            easy_drag=False,
            background_color="#070a12"
        )

        def on_loaded():
            time.sleep(0.3)
            cfg = self.config.config
            self.window.evaluate_js(f"receiveInitialConfig({json.dumps(cfg)})")
            if start_minimized:
                self.window.hide()

        self.window.events.loaded += on_loaded
        webview.start(debug=False)
