import time
import math
import threading
from typing import Callable, List, Dict, Optional, Tuple, Any
from ctypes import POINTER, c_float, c_uint32
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
        self.hold_time_sec: float = 0.040 # 40ms hold prevents gain chatter during full-auto sprays
        self._force_rescan: bool = False

        self.latest_peak: float = 0.0
        self.latest_channel_peaks: List[float] = [0.0, 0.0]
        self.telemetry_callback: Optional[Callable[[Dict[str, Any]], None]] = None

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

        device = None
        vol_endpoint = None
        master_meter = None
        callback_handler = None
        callback_ptr = None
        peaks_buffer = (c_float * 2)()

        def init_master_device():
            nonlocal device, vol_endpoint, master_meter, callback_handler, callback_ptr, peaks_buffer
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

        tick_interval = 0.010
        last_time = time.perf_counter()

        try:
            while self.running:
                now = time.perf_counter()
                dt = now - last_time
                last_time = now

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
                        for m in target_session_meters:
                            try:
                                session_peaks.append(float(m.GetPeakValue()))
                            except Exception:
                                pass
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

                if self.is_session_mode:
                    input_peak = min(2.0, raw_peak)
                    input_ch_peaks = [min(2.0, p) for p in raw_ch_peaks]
                else:
                    norm = max(0.01, self.current_attenuation_factor)
                    input_peak = min(2.0, raw_peak / norm)
                    input_ch_peaks = [min(2.0, p / norm) for p in raw_ch_peaks]

                self.latest_peak = input_peak
                self.latest_channel_peaks = input_ch_peaks

                # 3. Dynamic Compression / Limiting
                if enabled and input_peak > 0.0001:
                    target_att, gr_db = self._compute_soft_knee_attenuation(
                        input_peak, thresh_db, knee_mode, knee_width_db, ratio
                    )

                    if target_att < self.current_attenuation_factor:
                        tau_attack = 0.004
                        alpha_att = math.exp(-dt / tau_attack)
                        self.current_attenuation_factor = (
                            self.current_attenuation_factor * alpha_att + target_att * (1.0 - alpha_att)
                        )
                        self.hold_timer = self.hold_time_sec
                        self.is_limiting = True
                    else:
                        if self.hold_timer > 0.0:
                            self.hold_timer -= dt
                        else:
                            tau_rel = release_ms / 1000.0
                            alpha_rel = math.exp(-dt / tau_rel)
                            self.current_attenuation_factor = (
                                self.current_attenuation_factor * alpha_rel + target_att * (1.0 - alpha_rel)
                            )
                            if self.current_attenuation_factor >= 0.995:
                                self.current_attenuation_factor = 1.0
                                self.is_limiting = False

                    self.gain_reduction_db = 20.0 * math.log10(max(0.001, self.current_attenuation_factor))
                else:
                    if self.hold_timer > 0.0:
                        self.hold_timer -= dt
                    else:
                        tau_rel = release_ms / 1000.0
                        alpha_rel = math.exp(-dt / tau_rel)
                        self.current_attenuation_factor = (
                            self.current_attenuation_factor * alpha_rel + 1.0 * (1.0 - alpha_rel)
                        )
                        if self.current_attenuation_factor >= 0.995:
                            self.current_attenuation_factor = 1.0
                            self.is_limiting = False
                        self.gain_reduction_db = 0.0

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
                if self.telemetry_callback:
                    data = {
                        "peak": self.latest_peak,
                        "channel_peaks": self.latest_channel_peaks,
                        "gain_reduction_db": self.gain_reduction_db,
                        "active_target": self.active_session_name,
                        "is_game_isolated": self.is_session_mode,
                        "is_limiting": self.is_limiting,
                        "is_app_running": self.is_app_running,
                        "auto_watch_status": self.auto_watch_status
                    }
                    try:
                        self.telemetry_callback(data)
                    except Exception:
                        pass

                elapsed = time.perf_counter() - now
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
            CoUninitialize()
            CoUninitialize()
