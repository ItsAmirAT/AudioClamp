import threading
from typing import Callable, Optional
import keyboard

class HotkeyManager:
    def __init__(self, on_toggle: Callable[[], None], on_reset: Callable[[], None]):
        self.on_toggle = on_toggle
        self.on_reset = on_reset
        self.current_toggle_hotkey: Optional[str] = None
        self.current_reset_hotkey: Optional[str] = None
        self.lock = threading.Lock()

    def register_hotkeys(self, toggle_hotkey: str = "ctrl+alt+l", reset_hotkey: str = "ctrl+alt+r"):
        with self.lock:
            self.unregister_hotkeys()
            try:
                keyboard.add_hotkey(toggle_hotkey, self._handle_toggle, suppress=False)
                self.current_toggle_hotkey = toggle_hotkey
            except Exception as e:
                print(f"[HotkeyManager] Could not register toggle hotkey ({toggle_hotkey}): {e}")

            try:
                keyboard.add_hotkey(reset_hotkey, self._handle_reset, suppress=False)
                self.current_reset_hotkey = reset_hotkey
            except Exception as e:
                print(f"[HotkeyManager] Could not register reset hotkey ({reset_hotkey}): {e}")

    def unregister_hotkeys(self):
        try:
            if self.current_toggle_hotkey:
                keyboard.remove_hotkey(self.current_toggle_hotkey)
                self.current_toggle_hotkey = None
            if self.current_reset_hotkey:
                keyboard.remove_hotkey(self.current_reset_hotkey)
                self.current_reset_hotkey = None
        except Exception:
            pass

    def _handle_toggle(self):
        if self.on_toggle:
            self.on_toggle()

    def _handle_reset(self):
        if self.on_reset:
            self.on_reset()
