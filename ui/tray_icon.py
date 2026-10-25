import os
import threading
from typing import Callable
from PIL import Image
import pystray
from pystray import MenuItem as item

ASSETS_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "assets")

class TrayIconManager:
    def __init__(self,
                 on_toggle_show: Callable[[], None],
                 on_toggle_enable: Callable[[], None],
                 on_emergency_reset: Callable[[], None],
                 on_apply_preset: Callable[[str], None],
                 on_exit: Callable[[], None],
                 is_enabled_getter: Callable[[], bool]):
        self.on_toggle_show = on_toggle_show
        self.on_toggle_enable = on_toggle_enable
        self.on_emergency_reset = on_emergency_reset
        self.on_apply_preset = on_apply_preset
        self.on_exit = on_exit
        self.is_enabled_getter = is_enabled_getter

        self.icon_active = self._load_image("icon_active.png")
        self.icon_inactive = self._load_image("icon_inactive.png")
        self.tray_icon = None
        self.thread = None

    def _load_image(self, name: str) -> Image.Image:
        p = os.path.join(ASSETS_DIR, name)
        if os.path.exists(p):
            return Image.open(p)
        return Image.new("RGBA", (64, 64), (0, 242, 254, 255))

    def _create_menu(self):
        return pystray.Menu(
            item("Open AudioClamp", lambda icon, item: self.on_toggle_show(), default=True),
            item("Limiter Active", lambda icon, item: self.on_toggle_enable(), checked=lambda item: self.is_enabled_getter()),
            pystray.Menu.SEPARATOR,
            item("Emergency Volume Reset (100%)", lambda icon, item: self.on_emergency_reset()),
            pystray.Menu.SEPARATOR,
            item("Profiles", pystray.Menu(
                item("PUBG: BATTLEGROUNDS", lambda: self.on_apply_preset("PUBG: BATTLEGROUNDS")),
                item("Escape from Tarkov", lambda: self.on_apply_preset("Escape from Tarkov")),
                item("Counter-Strike 2", lambda: self.on_apply_preset("Counter-Strike 2")),
                item("Call of Duty / Warzone", lambda: self.on_apply_preset("Call of Duty / Warzone")),
                item("Valorant", lambda: self.on_apply_preset("Valorant")),
                item("Apex Legends", lambda: self.on_apply_preset("Apex Legends")),
                item("Cinema Night", lambda: self.on_apply_preset("Cinema / Movie Night")),
            )),
            pystray.Menu.SEPARATOR,
            item("Exit AudioClamp", lambda icon, item: self.on_exit())
        )

    def start(self):
        self.tray_icon = pystray.Icon(
            "AudioClamp",
            self.icon_active if self.is_enabled_getter() else self.icon_inactive,
            "AudioClamp - Studio Peak Limiter",
            menu=self._create_menu()
        )
        self.thread = threading.Thread(target=self.tray_icon.run, daemon=True)
        self.thread.start()

    def update_icon(self, is_enabled: bool):
        if self.tray_icon:
            self.tray_icon.icon = self.icon_active if is_enabled else self.icon_inactive
            self.tray_icon.title = f"AudioClamp - {'Active' if is_enabled else 'Bypassed'}"

    def stop(self):
        if self.tray_icon:
            try:
                self.tray_icon.stop()
            except Exception:
                pass
