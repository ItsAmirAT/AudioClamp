import time
import math
import threading
from typing import Callable, List, Dict, Optional, Tuple, Any
import ctypes
from ctypes import POINTER, c_float, c_uint32, wintypes
import psutil
from comtypes import COMMETHOD, HRESULT, IUnknown, GUID, CLSCTX_ALL, COMObject, CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED
from pycaw.pycaw import AudioUtilities, IAudioEndpointVolumeCallback, ISimpleAudioVolume
from core.config_manager import ConfigManager, GAME_PROFILES

class IAudioMeterInformationFull(IUnknown):
    _iid_ = GUID('{C02216F6-8C67-4B5B-9D00-D008E73E0064}')
    _methods_ = [
        COMMETHOD([], HRESULT, 'GetPeakValue',
                  (['out'], POINTER(c_float), 'pfPeak')),
        COMMETHOD([], HRESULT, 'GetMeteringChannelCount',
                  (['out'], POINTER(c_uint32), 'pnChannelCount')),
        COMMETHOD([], HRESULT, 'GetChannelsPeakValues',
                  (['in'], c_uint32, 'u32ChannelCount'),
                  (['in'], POINTER(c_float), 'afPeakValues')),
        COMMETHOD([], HRESULT, 'QueryHardwareSupport',
                  (['out'], POINTER(c_uint32), 'pdwHardwareSupportMask')),
    ]

class AudioCallbackHandler(COMObject):
    _com_interfaces_ = [IAudioEndpointVolumeCallback]

    def __init__(self, engine: "AudioEngine"):
        super().__init__()
        self.engine = engine

    def OnNotify(self, this, pNotify):
        data = pNotify.contents
        event_guid = str(data.guidEventContext)
        if event_guid != self.engine.limiter_guid_str and not self.engine.is_limiting:
            new_master = float(data.fMasterVolume)
            self.engine.on_user_master_volume_changed(new_master)
        return 0

class AudioEngine:
    def __init__(self, config: ConfigManager):
        self.config = config
        self.running = False
        self.thread: Optional[threading.Thread] = None
        self.lock = threading.Lock()

        self.limiter_guid = GUID.create_new()
        self.limiter_guid_str = str(self.limiter_guid)

        self.user_target_master_vol: float = 1.0
        self.current_applied_master_vol: float = 1.0
        self.channel_count: int = 2

        self.session_base_volumes: Dict[str, float] = {}
        self.touched_sessions: Dict[str, Any] = {}

        self.active_session_name: str = "Master Audio (Global)"
        self.active_session_pid: Optional[int] = None
        self.is_session_mode: bool = False
        self.is_app_running: bool = False
        self.auto_watch_status: str = "Standby"

        self.current_attenuation_factor: float = 1.0
        self.gain_reduction_db: float = 0.0
        self.is_limiting: bool = False
        self.hold_timer: float = 0.0
        self.hold_time_sec: float = 0.095 # 95ms hold prevents gain flutter during full-auto fire and captures acoustic reflections
        self._force_rescan: bool = False

        self.latest_peak: float = 0.0
        self.latest_channel_peaks: List[float] = [0.0, 0.0]
        self.telemetry_callback: Optional[Callable[[Dict[str, Any]], None]] = None
        self.on_profile_auto_switched: Optional[Callable[[str], None]] = None

    def rescan_sessions_now(self):
        self._force_rescan = True

    def on_user_master_volume_changed(self, new_vol: float):
        with self.lock:
            if not self.is_limiting:
                self.user_target_master_vol = max(0.01, min(1.0, new_vol))
                self.config.save_recovery_state("master", "System Master", self.user_target_master_vol)

    def emergency_reset_volume(self):
        with self.lock:
            self.current_attenuation_factor = 1.0
            self.gain_reduction_db = 0.0
            self.is_limiting = False
            self.restore_all_volumes_now()

    def restore_all_volumes_now(self):
        need_uninit = False
        try:
            try:
                CoInitializeEx(COINIT_MULTITHREADED)
                need_uninit = True
            except OSError:
                pass

            dev = AudioUtilities.GetSpeakers()
            if dev:
                dev.EndpointVolume.SetMasterVolumeLevelScalar(self.user_target_master_vol, self.limiter_guid)

            sessions = AudioUtilities.GetAllSessions()
            for s in sessions:
                p = s.Process
                if p:
                    proc_name = p.name()
                    base = self.session_base_volumes.get(proc_name, 1.0)
                    try:
                        s.SimpleAudioVolume.SetMasterVolume(base, None)
                    except Exception:
                        pass
        except Exception as e:
            print(f"[AudioEngine] Volume restoration notice: {e}")
        finally:
            if need_uninit:
                try:
                    CoUninitialize()
                except Exception:
                    pass

    def start(self):
        if self.running:
            return
        self.running = True
        self.thread = threading.Thread(target=self._limiter_worker, daemon=True)
        self.thread.start()

    def stop(self):
        if not self.running:
            return
        self.running = False
        if self.thread and self.thread.is_alive():
            self.thread.join(timeout=2.0)
        self.restore_all_volumes_now()

    def _compute_soft_knee_attenuation(self, peak_scalar: float, thresh_db: float,
                                       knee_mode: str, knee_width_db: float, ratio: float) -> Tuple[float, float]:
        if peak_scalar <= 0.00001:
            return 1.0, 0.0

        x = 20.0 * math.log10(peak_scalar)
        T = thresh_db
        W = max(0.5, knee_width_db)
        R = max(1.0, ratio)

        if knee_mode == "brickwall" or R >= 50.0:
            y = x if x <= T else T
        else:
            if x <= T - (W / 2.0):
                y = x
            elif x < T + (W / 2.0):
                overshoot = x - T + (W / 2.0)
                y = x + (overshoot ** 2) / (2.0 * W) * ((1.0 / R) - 1.0)
            else:
                y = T + (x - T) / R

        gr_db = y - x
        if gr_db > -0.05:
            return 1.0, 0.0

        attenuation_factor = 10.0 ** (gr_db / 20.0)
        return max(0.01, min(1.0, attenuation_factor)), gr_db

    def _limiter_worker(self):
        CoInitializeEx(COINIT_MULTITHREADED)

        winmm = None
        try:
            winmm = ctypes.windll.winmm
            winmm.timeBeginPeriod(1)
        except Exception:
            winmm = None

        avrt = None
        mmcss_handle = None
        try:
            avrt = ctypes.windll.avrt
            avrt.AvSetMmThreadCharacteristicsW.argtypes = [wintypes.LPCWSTR, wintypes.LPDWORD]
            avrt.AvSetMmThreadCharacteristicsW.restype = wintypes.HANDLE
            avrt.AvSetMmThreadPriority.argtypes = [wintypes.HANDLE, ctypes.c_int]
            avrt.AvSetMmThreadPriority.restype = wintypes.BOOL
            avrt.AvRevertMmThreadCharacteristics.argtypes = [wintypes.HANDLE]
            avrt.AvRevertMmThreadCharacteristics.restype = wintypes.BOOL

            task_index = wintypes.DWORD(0)
            mmcss_handle = avrt.AvSetMmThreadCharacteristicsW("Pro Audio", ctypes.byref(task_index))
            if mmcss_handle:
                avrt.AvSetMmThreadPriority(mmcss_handle, 2)
        except Exception:
            mmcss_handle = None

        device = None
        vol_endpoint = None
        master_meter = None
        callback_handler = None
        callback_ptr = None
        peaks_buffer = (c_float * 2)()

        def init_master_device():
            nonlocal device, vol_endpoint, master_meter, callback_handler, callback_ptr, peaks_buffer
            if vol_endpoint and callback_ptr:
                try:
                    vol_endpoint.UnregisterControlChangeNotify(callback_ptr)
                except Exception:
                    pass
            device = AudioUtilities.GetSpeakers()
            if not device:
                return False
            vol_endpoint = device.EndpointVolume
            master_meter_ptr = device._dev.Activate(IAudioMeterInformationFull._iid_, CLSCTX_ALL, None)
            master_meter = master_meter_ptr.QueryInterface(IAudioMeterInformationFull)
            self.channel_count = max(2, vol_endpoint.GetChannelCount())
            peaks_buffer = (c_float * self.channel_count)()

            callback_handler = AudioCallbackHandler(self)
            callback_ptr = callback_handler.QueryInterface(IAudioEndpointVolumeCallback)
            try:
                vol_endpoint.RegisterControlChangeNotify(callback_ptr)
            except Exception:
                pass

            initial_vol = vol_endpoint.GetMasterVolumeLevelScalar()
            with self.lock:
                self.user_target_master_vol = initial_vol
                self.current_applied_master_vol = initial_vol
            return True

        if not init_master_device():
            CoUninitialize()
            return

        last_session_scan_time = 0.0
        target_session_meters: List[Any] = []
        target_session_vols: List[Any] = []
        target_proc_name = ""

        prev_peak = 0.0
        loud_event_duration = 0.0
        last_fg_check_time = 0.0
        last_fg_pid = 0

        last_time = time.perf_counter()

        try:
            while self.running:
                now = time.perf_counter()
                dt = now - last_time
                last_time = now

                poll_ms = float(self.config.get("poll_cadence_ms", 3.0))
                tick_interval = max(0.0015, min(0.015, poll_ms / 1000.0))

                enabled = self.config.get("enabled", True)
                target_mode = self.config.get("target_mode", "auto_game")
                specific_app = self.config.get("target_process", "")
                thresh_db = float(self.config.get("threshold_db", -12.0))
                knee_mode = self.config.get("knee_mode", "soft_knee")
                knee_width_db = float(self.config.get("knee_width_db", 6.0))
                ratio = float(self.config.get("compression_ratio", 4.0))
                release_ms = max(40.0, float(self.config.get("release_ms", 120.0)))

                auto_watch = self.config.get("auto_watch_mode", True)
                monitored_apps = [m.lower() for m in self.config.get("monitored_apps", [])]

                # 0. Active Foreground Window Detection & Profile Auto-Switching
                if self.config.get("auto_profile_switch", True) and (now - last_fg_check_time > 0.4):
                    last_fg_check_time = now
                    try:
                        user32 = ctypes.windll.user32
                        hwnd_fg = user32.GetForegroundWindow()
                        if hwnd_fg:
                            fg_pid_dw = wintypes.DWORD()
                            user32.GetWindowThreadProcessId(hwnd_fg, ctypes.byref(fg_pid_dw))
                            cur_fg_pid = fg_pid_dw.value
                            if cur_fg_pid and cur_fg_pid != last_fg_pid:
                                last_fg_pid = cur_fg_pid
                                fg_proc = psutil.Process(cur_fg_pid)
                                fg_name = fg_proc.name().lower()
                                for prof_name, prof_data in GAME_PROFILES.items():
                                    exe_list = [e.lower() for e in prof_data.get("exe_names", [])]
                                    if fg_name in exe_list:
                                        if self.config.get("selected_profile") != prof_name:
                                            self.config.apply_profile(prof_name)
                                            if self.on_profile_auto_switched:
                                                try:
                                                    self.on_profile_auto_switched(prof_name)
                                                except Exception:
                                                    pass
                                        break
                    except Exception:
                        pass

                # 1. Periodic session scanner
                if (now - last_session_scan_time > 1.0) or self._force_rescan:
                    self._force_rescan = False
                    last_session_scan_time = now
                    if target_mode in ["auto_game", "specific_app"]:
                        try:
                            sessions = AudioUtilities.GetAllSessions()
                            matched_sessions = []
                            matched_proc_name = ""

                            for s in sessions:
                                proc = s.Process
                                if not proc:
                                    continue
                                try:
                                    proc_name = proc.name()
                                except Exception:
                                    continue
                                if not proc_name:
                                    continue

                                p_clean = proc_name.lower().removesuffix(".exe")
                                match = False

                                if target_mode == "specific_app" and specific_app:
                                    if p_clean == specific_app.lower().removesuffix(".exe"):
                                        match = True
                                elif target_mode == "auto_game":
                                    if any(p_clean == m.lower().removesuffix(".exe") for m in monitored_apps):
                                        match = True
                                    elif any(p_clean == exe.lower().removesuffix(".exe") for prof in GAME_PROFILES.values() for exe in prof.get("exe_names", [])):
                                        match = True

                                if match:
                                    matched_sessions.append((s, proc_name, proc.pid))
                                    if not matched_proc_name:
                                        matched_proc_name = proc_name

                            if matched_sessions:
                                target_session_meters = []
                                target_session_vols = []
                                target_proc_name = matched_proc_name
                                for s, pname, pid in matched_sessions:
                                    try:
                                        m = s._ctl.QueryInterface(IAudioMeterInformationFull)
                                        target_session_meters.append(m)
                                    except Exception:
                                        pass
                                    try:
                                        v = s.SimpleAudioVolume
                                        target_session_vols.append(v)
                                        if pname not in self.session_base_volumes:
                                            raw_vol = v.GetMasterVolume()
                                            self.session_base_volumes[pname] = 1.0 if raw_vol < 0.20 else raw_vol
                                    except Exception:
                                        pass

                                self.active_session_name = f"{matched_proc_name}"
                                self.active_session_pid = matched_sessions[0][2]
                                self.is_session_mode = True
                                self.is_app_running = True
                                self.auto_watch_status = f"Active: Clamping {matched_proc_name}"
                            else:
                                if target_session_vols:
                                    base = self.session_base_volumes.get(target_proc_name, 1.0)
                                    for v in target_session_vols:
                                        try:
                                            v.SetMasterVolume(base, self.limiter_guid)
                                        except Exception:
                                            pass
                                target_session_meters = []
                                target_session_vols = []
                                self.is_session_mode = False
                                self.is_app_running = False

                                if auto_watch:
                                    if vol_endpoint and self.is_limiting:
                                        vol_endpoint.SetMasterVolumeLevelScalar(self.user_target_master_vol, self.limiter_guid)
                                    self.current_attenuation_factor = 1.0
                                    self.gain_reduction_db = 0.0
                                    self.is_limiting = False
                                    if target_mode == "specific_app":
                                        self.active_session_name = f"Waiting for {specific_app}..." if specific_app else "No Process Selected"
                                        self.auto_watch_status = f"Standby: Waiting for {specific_app}" if specific_app else "Select an app below"
                                    else:
                                        self.active_session_name = "Watching for Games (Standby)"
                                        self.auto_watch_status = "Standby: Audio at 100% (Limiter sleeps until game opens)"
                                else:
                                    self.active_session_name = f"Master Audio ({specific_app} not running)" if target_mode == "specific_app" else "Master Audio (Discord Protected)"
                                    self.auto_watch_status = "Fallback to Master Limiter"
                                self.active_session_pid = None
                        except Exception:
                            self.is_session_mode = False
                            self.is_app_running = False
                    else:
                        target_session_meters = []
                        target_session_vols = []
                        self.active_session_name = "Master Device (Entire PC)"
                        self.active_session_pid = None
                        self.is_session_mode = False
                        self.is_app_running = True
                        self.auto_watch_status = "Active: Entire PC"

                # 2. Read Peak Level & Dynamic Limiting
                # In auto_watch mode, if no target game is running, sleep without attenuating
                if auto_watch and target_mode in ["auto_game", "specific_app"] and not self.is_app_running:
                    self.latest_peak = 0.0
                    self.latest_channel_peaks = [0.0, 0.0]
                    self.gain_reduction_db = 0.0
                    self.is_limiting = False
                    if self.telemetry_callback:
                        data = {
                            "peak": 0.0,
                            "channel_peaks": [0.0, 0.0],
                            "gain_reduction_db": 0.0,
                            "active_target": self.active_session_name,
                            "is_game_isolated": False,
                            "is_limiting": False,
                            "is_app_running": False,
                            "auto_watch_status": self.auto_watch_status
                        }
                        try:
                            self.telemetry_callback(data)
                        except Exception:
                            pass
                    time.sleep(tick_interval)
                    continue

                # 2. Read Peak Level
                raw_peak = 0.0
                raw_ch_peaks = [0.0, 0.0]
                try:
                    if self.is_session_mode and target_session_meters:
                        session_peaks = []
                        for m in list(target_session_meters):
                            try:
                                session_peaks.append(float(m.GetPeakValue()))
                            except Exception:
                                try:
                                    target_session_meters.remove(m)
                                except ValueError:
                                    pass
                                self._force_rescan = True
                        raw_peak = max(session_peaks) if session_peaks else 0.0
                        raw_ch_peaks = [raw_peak, raw_peak]
                    elif master_meter:
                        raw_peak = float(master_meter.GetPeakValue())
                        master_meter.GetChannelsPeakValues(self.channel_count, peaks_buffer)
                        raw_ch_peaks = [float(peaks_buffer[i]) for i in range(min(self.channel_count, 8))]
                except Exception:
                    init_master_device()
                    continue

                if self.config.get("stereo_linked", True) and len(raw_ch_peaks) >= 2:
                    raw_peak = max(raw_ch_peaks[0], raw_ch_peaks[1])

                input_peak = min(2.0, raw_peak)
                input_ch_peaks = [min(2.0, p) for p in raw_ch_peaks]

                self.latest_peak = input_peak
                self.latest_channel_peaks = input_ch_peaks

                # 3. Dynamic Compression / Limiting
                if enabled and input_peak > 0.0001:
                    target_att, gr_db = self._compute_soft_knee_attenuation(
                        input_peak, thresh_db, knee_mode, knee_width_db, ratio
                    )

                    peak_delta = input_peak - prev_peak
                    peak_deriv = peak_delta / max(0.0005, dt)
                    is_steep_transient = (peak_deriv > 18.0 and input_peak > 0.10)
                    overshoot_db = -gr_db

                    if target_att < self.current_attenuation_factor or is_steep_transient:
                        loud_event_duration += dt
                        # Ultra-fast transient attack (0.4ms) captures the very first gunshot wavefront
                        tau_attack = 0.0004 if (is_steep_transient or overshoot_db > 5.0) else 0.0020
                        alpha_att = math.exp(-dt / tau_attack)
                        self.current_attenuation_factor = (
                            self.current_attenuation_factor * alpha_att + target_att * (1.0 - alpha_att)
                        )
                        # Gunshots have acoustic room/valley reverb tails that last 80-250ms.
                        # Holding the attenuation through the shot and early reflection tail prevents the tail from surging up (which causes fake echoes).
                        shot_hold = 0.120 if (is_steep_transient or overshoot_db > 4.0) else self.hold_time_sec
                        self.hold_timer = max(self.hold_timer, shot_hold)
                        self.is_limiting = True
                    else:
                        if self.hold_timer > 0.0:
                            self.hold_timer -= dt
                        else:
                            # Smooth natural release: never recover faster than 100ms on gunshot decays.
                            # This allows environmental reverb to die down naturally without pumping or artificial echo surges.
                            tau_rel = max(0.100, release_ms / 1000.0)
                            alpha_rel = math.exp(-dt / tau_rel)
                            self.current_attenuation_factor = (
                                self.current_attenuation_factor * alpha_rel + target_att * (1.0 - alpha_rel)
                            )
                            if self.current_attenuation_factor >= 0.995:
                                self.current_attenuation_factor = 1.0
                                self.is_limiting = False
                                loud_event_duration = 0.0

                    self.gain_reduction_db = 20.0 * math.log10(max(0.001, self.current_attenuation_factor))
                else:
                    if self.hold_timer > 0.0:
                        self.hold_timer -= dt
                    else:
                        tau_rel = max(0.100, release_ms / 1000.0)
                        alpha_rel = math.exp(-dt / tau_rel)
                        self.current_attenuation_factor = (
                            self.current_attenuation_factor * alpha_rel + 1.0 * (1.0 - alpha_rel)
                        )
                        if self.current_attenuation_factor >= 0.995:
                            self.current_attenuation_factor = 1.0
                            self.is_limiting = False
                            loud_event_duration = 0.0
                        self.gain_reduction_db = 0.0

                prev_peak = input_peak

                # 4. Apply Attenuation Relative to Fixed Baseline
                try:
                    clamped_att = max(0.01, min(1.0, self.current_attenuation_factor))
                    if self.is_session_mode and target_session_vols:
                        base = self.session_base_volumes.get(target_proc_name, 1.0)
                        new_session_vol = base if not enabled else max(0.01, min(1.0, base * clamped_att))
                        for v in target_session_vols:
                            try:
                                v.SetMasterVolume(new_session_vol, self.limiter_guid)
                            except Exception:
                                pass
                    elif vol_endpoint:
                        base = self.user_target_master_vol
                        new_master_vol = base if not enabled else max(0.01, min(1.0, base * clamped_att))
                        vol_endpoint.SetMasterVolumeLevelScalar(new_master_vol, self.limiter_guid)
                except Exception:
                    pass

                # 5. Telemetry
                elapsed = time.perf_counter() - now
                if self.telemetry_callback:
                    output_peak = self.latest_peak * self.current_attenuation_factor
                    data = {
                        "peak": self.latest_peak,
                        "output_peak": output_peak,
                        "channel_peaks": self.latest_channel_peaks,
                        "gain_reduction_db": self.gain_reduction_db,
                        "active_target": self.active_session_name,
                        "is_game_isolated": self.is_session_mode,
                        "is_limiting": self.is_limiting,
                        "is_app_running": self.is_app_running,
                        "auto_watch_status": self.auto_watch_status,
                        "poll_latency_ms": round(elapsed * 1000.0, 2),
                        "mmcss_active": bool(mmcss_handle is not None)
                    }
                    try:
                        self.telemetry_callback(data)
                    except Exception:
                        pass

                sleep_time = tick_interval - elapsed
                if sleep_time > 0:
                    time.sleep(sleep_time)

        finally:
            try:
                if vol_endpoint:
                    vol_endpoint.SetMasterVolumeLevelScalar(self.user_target_master_vol, self.limiter_guid)
                    if callback_ptr:
                        vol_endpoint.UnregisterControlChangeNotify(callback_ptr)
                if target_session_vols:
                    base = self.session_base_volumes.get(target_proc_name, 1.0)
                    for v in target_session_vols:
                        try:
                            v.SetMasterVolume(base, None)
                        except Exception:
                            pass
            except Exception:
                pass
            if avrt and mmcss_handle:
                try:
                    avrt.AvRevertMmThreadCharacteristics(mmcss_handle)
                except Exception:
                    pass
            if winmm:
                try:
                    winmm.timeEndPeriod(1)
                except Exception:
                    pass
            CoUninitialize()
