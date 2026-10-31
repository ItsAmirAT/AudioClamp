import threading
from typing import Callable, Optional
import keyboard

class HotkeyManager:
    def __init__(self, on_toggle: Callable[[], None], on_reset: Callable[[], None],
                 on_nudge_up: Optional[Callable[[], None]] = None,
                 on_nudge_down: Optional[Callable[[], None]] = None,
                 on_mini_mode: Optional[Callable[[], None]] = None):
        self.on_toggle = on_toggle
        self.on_reset = on_reset
        self.on_nudge_up = on_nudge_up
        self.on_nudge_down = on_nudge_down
        self.on_mini_mode = on_mini_mode
        self.current_toggle_hotkey: Optional[str] = None
        self.current_reset_hotkey: Optional[str] = None
        self.current_nudge_up_hotkey: Optional[str] = None
        self.current_nudge_down_hotkey: Optional[str] = None
        self.current_mini_mode_hotkey: Optional[str] = None
        self.lock = threading.Lock()

    def register_hotkeys(self, toggle_hotkey: str = "ctrl+alt+l", reset_hotkey: str = "ctrl+alt+r",
                         nudge_up_hotkey: str = "ctrl+alt+up", nudge_down_hotkey: str = "ctrl+alt+down",
                         mini_mode_hotkey: str = "ctrl+alt+m"):
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

            if self.on_nudge_up:
                try:
                    keyboard.add_hotkey(nudge_up_hotkey, self._handle_nudge_up, suppress=False)
                    self.current_nudge_up_hotkey = nudge_up_hotkey
                except Exception as e:
                    print(f"[HotkeyManager] Could not register nudge up hotkey ({nudge_up_hotkey}): {e}")

            if self.on_nudge_down:
                try:
                    keyboard.add_hotkey(nudge_down_hotkey, self._handle_nudge_down, suppress=False)
                    self.current_nudge_down_hotkey = nudge_down_hotkey
                except Exception as e:
                    print(f"[HotkeyManager] Could not register nudge down hotkey ({nudge_down_hotkey}): {e}")

            if self.on_mini_mode:
                try:
                    keyboard.add_hotkey(mini_mode_hotkey, self._handle_mini_mode, suppress=False)
                    self.current_mini_mode_hotkey = mini_mode_hotkey
                except Exception as e:
                    print(f"[HotkeyManager] Could not register mini mode hotkey ({mini_mode_hotkey}): {e}")

    def unregister_hotkeys(self):
        try:
            if self.current_toggle_hotkey:
                keyboard.remove_hotkey(self.current_toggle_hotkey)
                self.current_toggle_hotkey = None
            if self.current_reset_hotkey:
                keyboard.remove_hotkey(self.current_reset_hotkey)
                self.current_reset_hotkey = None
            if self.current_nudge_up_hotkey:
                keyboard.remove_hotkey(self.current_nudge_up_hotkey)
                self.current_nudge_up_hotkey = None
            if self.current_nudge_down_hotkey:
                keyboard.remove_hotkey(self.current_nudge_down_hotkey)
                self.current_nudge_down_hotkey = None
            if self.current_mini_mode_hotkey:
                keyboard.remove_hotkey(self.current_mini_mode_hotkey)
                self.current_mini_mode_hotkey = None
        except Exception:
            pass

    def _handle_toggle(self):
        if self.on_toggle:
            self.on_toggle()

    def _handle_reset(self):
        if self.on_reset:
            self.on_reset()

    def _handle_nudge_up(self):
        if self.on_nudge_up:
            self.on_nudge_up()

    def _handle_nudge_down(self):
        if self.on_nudge_down:
            self.on_nudge_down()

    def _handle_mini_mode(self):
        if self.on_mini_mode:
            self.on_mini_mode()
