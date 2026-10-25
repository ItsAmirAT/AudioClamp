import sys
import os
import atexit
import signal
import ctypes

try:
    ctypes.windll.user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
except Exception:
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)
    except Exception:
        try:
            ctypes.windll.user32.SetProcessDPIAware()
        except Exception:
            pass

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from core.config_manager import ConfigManager
from core.audio_engine import AudioEngine
from ui.webview_window import WebviewWindow

MUTEX_NAME = "AudioClamp_SingleInstance_Mutex_391827"

def acquire_mutex():
    kernel32 = ctypes.windll.kernel32
    mutex = kernel32.CreateMutexW(None, False, MUTEX_NAME)
    last_error = kernel32.GetLastError()
    if last_error == 183:
        try:
            user32 = ctypes.windll.user32
            hwnd = user32.FindWindowW(None, "AudioClamp")
            if hwnd:
                user32.ShowWindow(hwnd, 9)
                user32.SetForegroundWindow(hwnd)
        except Exception:
            pass
        sys.exit(0)
    return mutex

def main():
    mutex = acquire_mutex()

    config = ConfigManager()
    engine = AudioEngine(config)

    def cleanup():
        engine.stop()

    atexit.register(cleanup)
    signal.signal(signal.SIGINT, lambda s, f: sys.exit(0))
    signal.signal(signal.SIGTERM, lambda s, f: sys.exit(0))

    engine.start()

    start_minimized = ("--minimized" in sys.argv) or config.get("start_minimized", False)
    app = WebviewWindow(config, engine)

    try:
        app.run(start_minimized=start_minimized)
    finally:
        cleanup()
        if mutex:
            ctypes.windll.kernel32.CloseHandle(mutex)

if __name__ == "__main__":
    main()
