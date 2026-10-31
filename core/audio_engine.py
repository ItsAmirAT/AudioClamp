import gc
import os
import time
import math
import threading
from typing import Callable, List, Dict, Optional, Tuple, Any, Set
import ctypes
from ctypes import POINTER, c_float, c_uint32, wintypes
import psutil
from comtypes import COMMETHOD, HRESULT, IUnknown, GUID, CLSCTX_ALL, COMObject, CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED
from pycaw.pycaw import AudioUtilities, IAudioEndpointVolumeCallback, ISimpleAudioVolume
from pycaw.callbacks import MMNotificationClient
from core.config_manager import ConfigManager, GAME_PROFILES, GAME_EXE_STEMS, EXE_TO_PROFILE

# Telemetry pacing: full rate while audio is present, 5 Hz once the signal sits below -60 dBFS
SILENCE_PEAK = 0.001
TELEMETRY_ACTIVE_SEC = 0.050
TELEMETRY_IDLE_SEC = 0.200

# Two-stage release. Stage one recovers at the 40 ms floor while more than 3 dB of
# reduction remains, stage two eases the last 3 dB back at the user's release time.
RELEASE_FLOOR_SEC = 0.040
RELEASE_FAST_STAGE_DB = -3.0
RELEASE_FAST_STAGE_LIN = 10.0 ** (RELEASE_FAST_STAGE_DB / 20.0)

# Hearing-Safe mode (opt-in). Windows refreshes per-session peak meters only every ~28 ms, so
# the first crack of a shot always passes before any clamp can land. Hearing-Safe accepts that
# and protects everything after it: a hard cap at the ceiling, and a 150 ms combat hold so the
# next round in a burst arrives while gain is still down.
HEARING_SAFE_HOLD_SEC = 0.150

DEVICE_RETRY_SEC = 1.0
SESSION_RESCAN_SEC = 1.0
SESSION_RESCAN_TEST_SEC = 0.25
VOLUME_WRITE_EPSILON = 0.0005


class AudioDeviceChangeWatcher(MMNotificationClient):
    def __init__(self, engine: "AudioEngine"):
        super().__init__()
        self.engine = engine

    def on_default_device_changed(self, flow, flow_id, role, role_id, default_device_id):
        if flow_id == 0 or str(flow) == "eRender":
            self.engine.signal_device_changed()

class IAudioMeterInformationFull(IUnknown):
    _iid_ = GUID('{C02216F6-8C67-4B5B-9D00-D008E73E0064}')
    # GetPeakValue takes a caller-owned float pointer so the hot loop reuses one buffer
    # instead of allocating an out-parameter on every read.
    _methods_ = [
        COMMETHOD([], HRESULT, 'GetPeakValue',
                  (['in'], POINTER(c_float), 'pfPeak')),
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

CLSID_PolicyConfigClient = GUID('{870AF99C-171D-4F9E-AF0D-E63Df40c2BC9}')
IID_IPolicyConfig = GUID('{F8679F50-850A-41CF-9C72-430F290290C8}')

class IPolicyConfig(IUnknown):
    _iid_ = IID_IPolicyConfig
    _methods_ = [
        COMMETHOD([], HRESULT, 'GetMixFormat', (['in'], ctypes.c_wchar_p, 'pszDeviceName'), (['out'], POINTER(ctypes.c_void_p), 'ppFormat')),
        COMMETHOD([], HRESULT, 'GetDeviceFormat', (['in'], ctypes.c_wchar_p, 'pszDeviceName'), (['in'], ctypes.c_int, 'bMixFormat'), (['out'], POINTER(ctypes.c_void_p), 'ppFormat')),
        COMMETHOD([], HRESULT, 'ResetDeviceFormat', (['in'], ctypes.c_wchar_p, 'pszDeviceName')),
        COMMETHOD([], HRESULT, 'SetDeviceFormat', (['in'], ctypes.c_wchar_p, 'pszDeviceName'), (['in'], ctypes.c_void_p, 'pEndpointFormat')),
        COMMETHOD([], HRESULT, 'GetProcessingPeriod', (['in'], ctypes.c_wchar_p, 'pszDeviceName'), (['in'], ctypes.c_int, 'bDefault'), (['out'], POINTER(ctypes.c_void_p), 'pmnsDuration')),
        COMMETHOD([], HRESULT, 'SetProcessingPeriod', (['in'], ctypes.c_wchar_p, 'pszDeviceName'), (['in'], ctypes.c_void_p, 'pmnsDuration')),
        COMMETHOD([], HRESULT, 'GetShareMode', (['in'], ctypes.c_wchar_p, 'pszDeviceName'), (['out'], POINTER(ctypes.c_void_p), 'pMode')),
        COMMETHOD([], HRESULT, 'SetShareMode', (['in'], ctypes.c_wchar_p, 'pszDeviceName'), (['in'], ctypes.c_void_p, 'pMode')),
        COMMETHOD([], HRESULT, 'GetPropertyValue', (['in'], ctypes.c_wchar_p, 'pszDeviceName'), (['in'], ctypes.c_void_p, 'pKey'), (['out'], POINTER(ctypes.c_void_p), 'pv')),
        COMMETHOD([], HRESULT, 'SetPropertyValue', (['in'], ctypes.c_wchar_p, 'pszDeviceName'), (['in'], ctypes.c_void_p, 'pKey'), (['in'], ctypes.c_void_p, 'pv')),
        COMMETHOD([], HRESULT, 'SetDefaultEndpoint', (['in'], ctypes.c_wchar_p, 'pszDeviceName'), (['in'], ctypes.c_int, 'role')),
        COMMETHOD([], HRESULT, 'SetEndpointVisibility', (['in'], ctypes.c_wchar_p, 'pszDeviceName'), (['in'], ctypes.c_int, 'visible')),
    ]


def _com_enter() -> bool:
    """Join the multithreaded apartment. Returns True when the caller owns a CoUninitialize."""
    try:
        CoInitializeEx(COINIT_MULTITHREADED)
        return True
    except OSError:
        return False


def _com_leave(owned: bool) -> None:
    if owned:
        try:
            CoUninitialize()
        except Exception:
            pass


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

        # Baselines for game sessions, keyed by process name. Only sessions the limiter
        # has actually written to ever appear here, so restores never touch other apps.
        self.session_base_volumes: Dict[str, float] = {}
        # Baselines for the in-app audio test sessions, keyed by pid
        self._test_session_bases: Dict[int, float] = {}
        self._audio_test_pids: frozenset = frozenset()
        self._master_touched: bool = False

        self.active_session_name: str = "Master Audio (Global)"
        self.active_session_pid: Optional[int] = None
        self.is_session_mode: bool = False
        self.is_app_running: bool = False
        self.auto_watch_status: str = "Standby"

        self.current_attenuation_factor: float = 1.0
        self.gain_reduction_db: float = 0.0
        self.is_limiting: bool = False
        self.hold_timer: float = 0.0
        self.hold_time_sec: float = 0.030 # 30ms hold covers blast transients without merging overlapping sounds
        self.active_device_name: str = "Default Audio Output"
        self._device_changed: bool = False
        self._force_rescan: bool = False

        self.latest_peak: float = 0.0
        self.latest_channel_peaks: List[float] = [0.0, 0.0]
        self.telemetry_callback: Optional[Callable[[Dict[str, Any]], None]] = None
        self.on_profile_auto_switched: Optional[Callable[[str], None]] = None

        # Reused telemetry payload. Consumers must serialize it synchronously and not keep a reference.
        self._telemetry_channel_peaks: List[float] = [0.0, 0.0]
        self._telemetry: Dict[str, Any] = {
            "peak": 0.0,
            "output_peak": 0.0,
            "channel_peaks": self._telemetry_channel_peaks,
            "gain_reduction_db": 0.0,
            "active_target": self.active_session_name,
            "is_game_isolated": False,
            "is_limiting": False,
            "is_app_running": False,
            "auto_watch_status": self.auto_watch_status,
            "poll_latency_ms": 0.0,
            "mmcss_active": False,
            "device_name": self.active_device_name,
            "eco_mode": False,
            "audio_test_active": False,
            "hearing_safe": False,
        }

    def signal_device_changed(self):
        self._device_changed = True
        self._force_rescan = True

    def rescan_sessions_now(self):
        self._force_rescan = True

    # ------------------------------------------------------------------
    # In-app audio test routing
    # ------------------------------------------------------------------
    @staticmethod
    def own_process_tree_pids() -> Set[int]:
        """PIDs of this process and its descendants (the WebView2 audio service lives here)."""
        pids: Set[int] = {os.getpid()}
        try:
            for child in psutil.Process(os.getpid()).children(recursive=True):
                pids.add(child.pid)
        except Exception:
            pass
        return pids

    def begin_audio_test(self) -> None:
        """Temporarily clamp this app's own audio sessions so the test tone runs through the limiter."""
        self._audio_test_pids = frozenset(self.own_process_tree_pids())
        self._force_rescan = True

    def end_audio_test(self) -> None:
        self._audio_test_pids = frozenset()
        self._force_rescan = True

    # ------------------------------------------------------------------
    # Active stream discovery
    # ------------------------------------------------------------------
    def sample_audio_streams(self, window_sec: float = 0.18, samples: int = 6) -> List[Dict[str, Any]]:
        """Return audio sessions ranked by how loud they are right now.

        Each session meter is sampled several times across a short window because a single
        read lands between sounds far too often to be useful.
        """
        owned = _com_enter()
        try:
            own_pids = self.own_process_tree_pids()
            entries: Dict[str, Dict[str, Any]] = {}
            meters: List[Tuple[str, Any]] = []
            for s in AudioUtilities.GetAllSessions():
                try:
                    pid = s.ProcessId
                    if not pid or pid in own_pids:
                        continue
                    name = psutil.Process(pid).name()
                except Exception:
                    continue
                if not name:
                    continue
                try:
                    state_active = int(s._ctl.GetState()) == 1
                except Exception:
                    state_active = False
                entry = entries.setdefault(name, {"name": name, "pid": pid, "peak": 0.0, "session_active": False})
                entry["session_active"] = entry["session_active"] or state_active
                try:
                    meters.append((name, s._ctl.QueryInterface(IAudioMeterInformationFull)))
                except Exception:
                    pass

            peak_value = c_float(0.0)
            peak_ptr = ctypes.pointer(peak_value)
            interval = window_sec / max(1, samples)
            for i in range(max(1, samples)):
                for name, meter in meters:
                    try:
                        meter.GetPeakValue(peak_ptr)
                        if peak_value.value > entries[name]["peak"]:
                            entries[name]["peak"] = float(peak_value.value)
                    except Exception:
                        pass
                if i < samples - 1:
                    time.sleep(interval)

            result = []
            for e in entries.values():
                e["peak_db"] = round(20.0 * math.log10(e["peak"]), 1) if e["peak"] > 0.00001 else None
                e["producing_sound"] = e["peak"] > 0.0005
                e["peak"] = round(e["peak"], 5)
                result.append(e)
            result.sort(key=lambda e: (not e["producing_sound"], -e["peak"], not e["session_active"], e["name"].lower()))
            return result
        except Exception as e:
            print(f"[AudioEngine] Failed to sample audio streams: {e}")
            return []
        finally:
            _com_leave(owned)

    # ------------------------------------------------------------------
    # Device management
    # ------------------------------------------------------------------
    def get_playback_devices(self) -> List[Dict[str, Any]]:
        owned = _com_enter()
        try:
            de = AudioUtilities.GetDeviceEnumerator()
            from pycaw.constants import EDataFlow, DEVICE_STATE
            collection = de.EnumAudioEndpoints(EDataFlow.eRender.value, DEVICE_STATE.ACTIVE.value)
            count = collection.GetCount()

            default_speaker = AudioUtilities.GetSpeakers()
            default_id = default_speaker.id if default_speaker and hasattr(default_speaker, "id") else ""

            devices_list = []
            for i in range(count):
                dev_item = collection.Item(i)
                ad = AudioUtilities.CreateDevice(dev_item)
                dev_id = getattr(ad, "id", "")
                name = getattr(ad, "FriendlyName", f"Audio Output {i+1}")
                devices_list.append({
                    "id": dev_id,
                    "name": name,
                    "is_default": bool(dev_id and dev_id == default_id)
                })
            return devices_list
        except Exception as e:
            print(f"[AudioEngine] Failed to enumerate playback devices: {e}")
            return []
        finally:
            _com_leave(owned)

    def set_default_playback_device(self, device_id: str) -> bool:
        owned = _com_enter()
        try:
            from comtypes import CoCreateInstance
            policy_config = CoCreateInstance(CLSID_PolicyConfigClient, IPolicyConfig, CLSCTX_ALL)
            # Set for Console (0), Multimedia (1), and Communications (2)
            policy_config.SetDefaultEndpoint(device_id, 0)
            policy_config.SetDefaultEndpoint(device_id, 1)
            policy_config.SetDefaultEndpoint(device_id, 2)
            self.signal_device_changed()
            return True
        except Exception as e:
            print(f"[AudioEngine] Failed to set default endpoint {device_id}: {e}")
            return False
        finally:
            _com_leave(owned)

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
        """Put back only what the limiter changed: its own game sessions, test sessions, and the
        master endpoint if master clamping ever ran. Every other app keeps its mixer level."""
        owned = _com_enter()
        try:
            if self._master_touched:
                dev = AudioUtilities.GetSpeakers()
                if dev:
                    dev.EndpointVolume.SetMasterVolumeLevelScalar(self.user_target_master_vol, self.limiter_guid)

            test_bases = dict(self._test_session_bases)
            if not self.session_base_volumes and not test_bases:
                return

            for s in AudioUtilities.GetAllSessions():
                try:
                    pid = s.ProcessId
                except Exception:
                    continue
                if not pid:
                    continue
                base: Optional[float] = test_bases.get(pid)
                if base is None:
                    try:
                        proc_name = psutil.Process(pid).name()
                    except Exception:
                        continue
                    base = self.session_base_volumes.get(proc_name)
                if base is None:
                    continue
                try:
                    s.SimpleAudioVolume.SetMasterVolume(base, None)
                except Exception:
                    pass
        except Exception as e:
            print(f"[AudioEngine] Volume restoration notice: {e}")
        finally:
            _com_leave(owned)

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

    # ------------------------------------------------------------------
    # DSP
    # ------------------------------------------------------------------
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

    @staticmethod
    def _release_step(current: float, target: float, dt: float, release_ms: float,
                      fast_stage: bool = True) -> float:
        """One release tick. Gain only moves up toward target; the time constant never drops
        below the 40 ms floor, so reverb tails decay naturally instead of surging back."""
        if fast_stage and current < RELEASE_FAST_STAGE_LIN:
            tau = RELEASE_FLOOR_SEC
        else:
            tau = max(RELEASE_FLOOR_SEC, release_ms / 1000.0)
        alpha = math.exp(-dt / tau)
        return current * alpha + target * (1.0 - alpha)

    # ------------------------------------------------------------------
    # Worker thread
    # ------------------------------------------------------------------
    def _limiter_worker(self):
        com_owned = _com_enter()

        winmm = None
        avrt = None
        mmcss_handle = None
        device_enum = None
        watcher = None
        try:
            try:
                winmm = ctypes.windll.winmm
                winmm.timeBeginPeriod(1)
            except Exception:
                winmm = None

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
                else:
                    mmcss_handle = None
            except Exception:
                mmcss_handle = None

            try:
                device_enum = AudioUtilities.GetDeviceEnumerator()
                watcher = AudioDeviceChangeWatcher(self)
                device_enum.RegisterEndpointNotificationCallback(watcher)
            except Exception:
                watcher = None
                device_enum = None

            self._run_loop(mmcss_handle is not None)
        except Exception as e:
            print(f"[AudioEngine] Limiter worker stopped unexpectedly: {e}")
        finally:
            if device_enum and watcher:
                try:
                    device_enum.UnregisterEndpointNotificationCallback(watcher)
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
            _com_leave(com_owned)

    def _run_loop(self, mmcss_active: bool) -> None:
        guid = self.limiter_guid
        perf_counter = time.perf_counter
        sleep = time.sleep
        exp = math.exp
        log10 = math.log10

        # ---- Master endpoint state ----
        vol_endpoint = None
        master_meter = None
        callback_handler = None
        callback_ptr = None
        peaks_buffer = (c_float * 2)()
        peak_value = c_float(0.0)
        peak_ptr = ctypes.pointer(peak_value)
        last_master_written = -1.0
        next_device_retry = 0.0

        def release_master_device() -> None:
            nonlocal vol_endpoint, master_meter, callback_handler, callback_ptr
            if vol_endpoint is not None and callback_ptr is not None:
                try:
                    vol_endpoint.UnregisterControlChangeNotify(callback_ptr)
                except Exception:
                    pass
            vol_endpoint = None
            master_meter = None
            callback_handler = None
            callback_ptr = None

        def init_master_device() -> bool:
            """(Re)bind the default render endpoint. Never raises; returns False when no device is usable."""
            nonlocal vol_endpoint, master_meter, callback_handler, callback_ptr, peaks_buffer, last_master_written
            release_master_device()
            try:
                device = AudioUtilities.GetSpeakers()
                if not device:
                    return False
                endpoint = device.EndpointVolume
                meter = device._dev.Activate(IAudioMeterInformationFull._iid_, CLSCTX_ALL, None).QueryInterface(IAudioMeterInformationFull)
                channels = max(2, int(endpoint.GetChannelCount()))
                handler = AudioCallbackHandler(self)
                ptr = handler.QueryInterface(IAudioEndpointVolumeCallback)
                try:
                    endpoint.RegisterControlChangeNotify(ptr)
                except Exception:
                    ptr = None
                initial_vol = float(endpoint.GetMasterVolumeLevelScalar())
                device_name = getattr(device, "FriendlyName", "Default Audio Endpoint")
            except Exception as e:
                print(f"[AudioEngine] Audio endpoint unavailable: {e}")
                return False

            vol_endpoint = endpoint
            master_meter = meter
            callback_handler = handler
            callback_ptr = ptr
            self.active_device_name = device_name
            self.channel_count = channels
            if len(peaks_buffer) != channels:
                peaks_buffer = (c_float * channels)()
            last_master_written = -1.0
            with self.lock:
                self.user_target_master_vol = initial_vol
                self.current_applied_master_vol = initial_vol
            return True

        def write_master(value: float) -> None:
            nonlocal last_master_written
            if vol_endpoint is None:
                return
            if abs(value - last_master_written) <= VOLUME_WRITE_EPSILON:
                return
            vol_endpoint.SetMasterVolumeLevelScalar(value, guid)
            last_master_written = value
            self.current_applied_master_vol = value
            self._master_touched = True

        if not init_master_device():
            next_device_retry = perf_counter() + DEVICE_RETRY_SEC

        # ---- Session targets (parallel lists rebuilt only on rescan) ----
        t_pids: List[int] = []
        t_meters: List[Any] = []
        t_vols: List[Any] = []
        t_bases: List[float] = []
        t_last: List[float] = []
        pid_name_cache: Dict[int, str] = {}

        def release_targets(keep_pids: Set[int]) -> None:
            """Return every dropped session to its baseline before forgetting it."""
            for i in range(len(t_pids)):
                if t_pids[i] in keep_pids:
                    continue
                try:
                    t_vols[i].SetMasterVolume(t_bases[i], guid)
                except Exception:
                    pass
                self._test_session_bases.pop(t_pids[i], None)

        # ---- Cached settings, refreshed only when the config revision changes ----
        cfg_rev = -1
        eco_active = False
        base_tick = 0.003
        enabled = True
        target_mode = "auto_game"
        specific_app = ""
        specific_stem = ""
        thresh_db = -12.0
        knee_mode = "soft_knee"
        knee_width_db = 6.0
        ratio = 4.0
        release_ms = 120.0
        hold_duration = 0.030
        auto_watch = True
        auto_profile = True
        stereo_linked = True
        hearing_safe = False
        eff_knee_mode = "soft_knee"
        monitored_stems: frozenset = frozenset()

        prev_peak = 0.0
        last_fg_check_time = 0.0
        last_fg_pid = 0
        last_session_scan_time = 0.0
        silence_ticks = 0
        test_session_found = False

        # Telemetry accumulators: the max over each dispatch window, so short transients
        # are never lost between GUI updates.
        tele = self._telemetry
        tele_ch = self._telemetry_channel_peaks
        acc_peak = 0.0
        acc_out = 0.0
        acc_ch0 = 0.0
        acc_ch1 = 0.0
        acc_gr = 0.0
        acc_limiting = False
        last_tele_time = 0.0
        was_quiet = True

        last_time = perf_counter()

        try:
            while self.running:
                now = perf_counter()
                dt = now - last_time
                last_time = now

                if self._device_changed:
                    self._device_changed = False
                    if not init_master_device():
                        next_device_retry = now + DEVICE_RETRY_SEC

                rev = self.config.revision
                if rev != cfg_rev:
                    cfg_rev = rev
                    cfg = self.config
                    eco_active = bool(cfg.get("eco_mode", False))
                    poll_ms = float(cfg.get("poll_cadence_ms", 3.0))
                    base_tick = 0.006 if eco_active else max(0.0015, min(0.015, poll_ms / 1000.0))
                    enabled = bool(cfg.get("enabled", True))
                    new_mode = cfg.get("target_mode", "auto_game")
                    if new_mode != target_mode:
                        self._force_rescan = True
                    target_mode = new_mode
                    specific_app = cfg.get("target_process", "") or ""
                    specific_stem = specific_app.lower().removesuffix(".exe")
                    thresh_db = float(cfg.get("threshold_db", -12.0))
                    knee_mode = cfg.get("knee_mode", "soft_knee")
                    knee_width_db = float(cfg.get("knee_width_db", 6.0))
                    ratio = float(cfg.get("compression_ratio", 4.0))
                    release_ms = max(40.0, float(cfg.get("release_ms", 120.0)))
                    # Adaptive hold: 25ms to 38ms covers the blast and gunshot crack without freezing out subsequent bullets
                    hold_duration = max(0.025, min(0.038, release_ms / 3500.0))
                    auto_watch = bool(cfg.get("auto_watch_mode", True))
                    auto_profile = bool(cfg.get("auto_profile_switch", True))
                    stereo_linked = bool(cfg.get("stereo_linked", True))
                    hearing_safe = bool(cfg.get("hearing_safe", False))
                    eff_knee_mode = "brickwall" if hearing_safe else knee_mode
                    if hearing_safe:
                        hold_duration = HEARING_SAFE_HOLD_SEC
                    monitored_stems = frozenset(m.lower().removesuffix(".exe") for m in cfg.get("monitored_apps", []))

                session_targeting = target_mode == "auto_game" or target_mode == "specific_app"

                # 0. Active foreground window detection & profile auto-switching
                if auto_profile and (now - last_fg_check_time > 0.4):
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
                                prof_name = EXE_TO_PROFILE.get(psutil.Process(cur_fg_pid).name().lower())
                                if prof_name and self.config.get("selected_profile") != prof_name:
                                    self.config.apply_profile(prof_name)
                                    if self.on_profile_auto_switched:
                                        try:
                                            self.on_profile_auto_switched(prof_name)
                                        except Exception:
                                            pass
                    except Exception:
                        pass

                # 1. Session scanner
                test_pids = self._audio_test_pids
                rescan_interval = SESSION_RESCAN_TEST_SEC if (test_pids and not test_session_found) else SESSION_RESCAN_SEC
                if (now - last_session_scan_time > rescan_interval) or self._force_rescan:
                    self._force_rescan = False
                    last_session_scan_time = now
                    if session_targeting:
                        try:
                            new_pids: List[int] = []
                            new_meters: List[Any] = []
                            new_vols: List[Any] = []
                            new_bases: List[float] = []
                            new_cache: Dict[int, str] = {}
                            matched_proc_name = ""
                            matched_pid: Optional[int] = None
                            found_test = False
                            old_index = {pid: i for i, pid in enumerate(t_pids)}

                            for s in AudioUtilities.GetAllSessions():
                                try:
                                    pid = s.ProcessId
                                except Exception:
                                    continue
                                if not pid:
                                    continue
                                proc_name = pid_name_cache.get(pid)
                                if proc_name is None:
                                    try:
                                        proc_name = psutil.Process(pid).name()
                                    except Exception:
                                        continue
                                if not proc_name:
                                    continue
                                new_cache[pid] = proc_name

                                is_test = pid in test_pids
                                if not is_test:
                                    p_clean = proc_name.lower().removesuffix(".exe")
                                    if target_mode == "specific_app":
                                        if not specific_stem or p_clean != specific_stem:
                                            continue
                                    elif p_clean not in monitored_stems and p_clean not in GAME_EXE_STEMS:
                                        continue

                                try:
                                    meter = s._ctl.QueryInterface(IAudioMeterInformationFull)
                                    vol = s._ctl.QueryInterface(ISimpleAudioVolume)
                                except Exception:
                                    continue

                                prev_i = old_index.get(pid)
                                if prev_i is not None:
                                    base = t_bases[prev_i]
                                elif is_test:
                                    base = self._test_session_bases.get(pid)
                                    if base is None:
                                        try:
                                            raw_vol = float(vol.GetMasterVolume())
                                        except Exception:
                                            raw_vol = 1.0
                                        base = 1.0 if raw_vol < 0.20 else raw_vol
                                        self._test_session_bases[pid] = base
                                else:
                                    base = self.session_base_volumes.get(proc_name)
                                    if base is None:
                                        try:
                                            raw_vol = float(vol.GetMasterVolume())
                                        except Exception:
                                            raw_vol = 1.0
                                        base = 1.0 if raw_vol < 0.20 else raw_vol
                                        self.session_base_volumes[proc_name] = base

                                new_pids.append(pid)
                                new_meters.append(meter)
                                new_vols.append(vol)
                                new_bases.append(base)
                                if is_test:
                                    found_test = True
                                elif not matched_proc_name:
                                    matched_proc_name = proc_name
                                    matched_pid = pid

                            pid_name_cache = new_cache
                            test_session_found = found_test
                            release_targets(set(new_pids))
                            t_pids, t_meters, t_vols, t_bases = new_pids, new_meters, new_vols, new_bases
                            t_last = [-1.0] * len(t_pids)

                            if t_pids:
                                display_name = matched_proc_name or "AudioClamp Test Audio"
                                self.active_session_name = display_name
                                self.active_session_pid = matched_pid
                                self.is_session_mode = True
                                self.is_app_running = True
                                self.auto_watch_status = f"Active: Clamping {display_name}"
                            else:
                                self.is_session_mode = False
                                self.is_app_running = False

                                if auto_watch:
                                    if vol_endpoint is not None and self.is_limiting:
                                        try:
                                            write_master(self.user_target_master_vol)
                                        except Exception:
                                            pass
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
                        if t_pids:
                            release_targets(set())
                            t_pids, t_meters, t_vols, t_bases, t_last = [], [], [], [], []
                        test_session_found = False
                        self.active_session_name = "Master Device (Entire PC)"
                        self.active_session_pid = None
                        self.is_session_mode = False
                        self.is_app_running = True
                        self.auto_watch_status = "Active: Entire PC"

                # 2a. Standby: auto-watch is on and no target is running, so leave audio alone
                if auto_watch and session_targeting and not self.is_app_running:
                    self.latest_peak = 0.0
                    self.latest_channel_peaks[0] = 0.0
                    self.latest_channel_peaks[1] = 0.0
                    self.gain_reduction_db = 0.0
                    self.is_limiting = False
                    prev_peak = 0.0
                    silence_ticks += 1
                    if self.telemetry_callback and (now - last_tele_time >= TELEMETRY_IDLE_SEC):
                        last_tele_time = now
                        tele["peak"] = 0.0
                        tele["output_peak"] = 0.0
                        tele_ch[0] = 0.0
                        tele_ch[1] = 0.0
                        tele["gain_reduction_db"] = 0.0
                        tele["active_target"] = self.active_session_name
                        tele["is_game_isolated"] = False
                        tele["is_limiting"] = False
                        tele["is_app_running"] = False
                        tele["auto_watch_status"] = self.auto_watch_status
                        tele["poll_latency_ms"] = 0.0
                        tele["mmcss_active"] = mmcss_active
                        tele["device_name"] = self.active_device_name
                        tele["eco_mode"] = eco_active
                        tele["audio_test_active"] = bool(test_pids)
                        tele["hearing_safe"] = hearing_safe
                        try:
                            self.telemetry_callback(tele)
                        except Exception:
                            pass
                    was_quiet = True
                    if silence_ticks % 600 == 0:
                        gc.collect()
                    sleep(0.035 if eco_active else 0.022)
                    continue

                # 2b. Read peak level
                raw_peak = 0.0
                ch0 = 0.0
                ch1 = 0.0
                if self.is_session_mode and t_meters:
                    lost_session = False
                    for m in t_meters:
                        try:
                            m.GetPeakValue(peak_ptr)
                            v = peak_value.value
                            if v > raw_peak:
                                raw_peak = v
                        except Exception:
                            lost_session = True
                    if lost_session:
                        self._force_rescan = True
                    ch0 = raw_peak
                    ch1 = raw_peak
                elif master_meter is not None:
                    try:
                        master_meter.GetPeakValue(peak_ptr)
                        raw_peak = peak_value.value
                        master_meter.GetChannelsPeakValues(self.channel_count, peaks_buffer)
                        ch0 = peaks_buffer[0]
                        ch1 = peaks_buffer[1]
                    except Exception:
                        # Endpoint vanished (unplugged, driver reset). Drop it and retry on a timer
                        # rather than spinning on a dead interface.
                        release_master_device()
                        next_device_retry = now
                        sleep(0.05)
                        continue
                else:
                    if now >= next_device_retry:
                        if not init_master_device():
                            next_device_retry = now + DEVICE_RETRY_SEC
                    sleep(0.05)
                    continue

                if stereo_linked:
                    raw_peak = ch0 if ch0 > ch1 else ch1

                input_peak = raw_peak if raw_peak < 2.0 else 2.0
                if ch0 > 2.0:
                    ch0 = 2.0
                if ch1 > 2.0:
                    ch1 = 2.0

                self.latest_peak = input_peak
                self.latest_channel_peaks[0] = ch0
                self.latest_channel_peaks[1] = ch1

                # 3. Dynamic compression / limiting
                if enabled and input_peak > 0.0001:
                    target_att, gr_db = self._compute_soft_knee_attenuation(
                        input_peak, thresh_db, eff_knee_mode, knee_width_db, ratio
                    )

                    peak_deriv = (input_peak - prev_peak) / (dt if dt > 0.0005 else 0.0005)
                    is_steep_transient = (peak_deriv > 18.0 and input_peak > 0.10)

                    # Attack phase: ONLY engage when we need MORE attenuation (gain moving downwards)
                    if target_att < self.current_attenuation_factor:
                        # Ultra-fast transient attack (0.4ms) captures the very first gunshot wavefront
                        tau_attack = 0.0004 if (is_steep_transient or -gr_db > 5.0) else 0.0015
                        alpha_att = exp(-dt / tau_attack)
                        self.current_attenuation_factor = (
                            self.current_attenuation_factor * alpha_att + target_att * (1.0 - alpha_att)
                        )
                        self.hold_timer = hold_duration
                        self.is_limiting = True
                    else:
                        # Release / hold phase
                        if self.hold_timer > 0.0:
                            self.hold_timer -= dt
                        else:
                            self.current_attenuation_factor = self._release_step(
                                self.current_attenuation_factor, target_att, dt, release_ms, not hearing_safe
                            )
                            if self.current_attenuation_factor >= 0.995:
                                self.current_attenuation_factor = 1.0
                                self.is_limiting = False

                    att = self.current_attenuation_factor
                    self.gain_reduction_db = 20.0 * log10(att if att > 0.001 else 0.001)
                else:
                    if self.hold_timer > 0.0:
                        self.hold_timer -= dt
                    else:
                        self.current_attenuation_factor = self._release_step(
                            self.current_attenuation_factor, 1.0, dt, release_ms, not hearing_safe
                        )
                        if self.current_attenuation_factor >= 0.995:
                            self.current_attenuation_factor = 1.0
                            self.is_limiting = False
                        self.gain_reduction_db = 0.0

                prev_peak = input_peak

                # 4. Apply attenuation relative to the fixed baseline, skipping redundant COM writes
                att = self.current_attenuation_factor
                clamped_att = 0.01 if att < 0.01 else (1.0 if att > 1.0 else att)
                try:
                    if self.is_session_mode and t_vols:
                        for i in range(len(t_vols)):
                            base = t_bases[i]
                            new_vol = base if not enabled else max(0.01, min(1.0, base * clamped_att))
                            if abs(new_vol - t_last[i]) > VOLUME_WRITE_EPSILON:
                                try:
                                    t_vols[i].SetMasterVolume(new_vol, guid)
                                    t_last[i] = new_vol
                                except Exception:
                                    pass
                    elif vol_endpoint is not None:
                        base = self.user_target_master_vol
                        write_master(base if not enabled else max(0.01, min(1.0, base * clamped_att)))
                except Exception:
                    pass

                # Adaptive idle cadence
                tick_interval = base_tick
                if input_peak < 0.0005:
                    silence_ticks += 1
                    if silence_ticks > 250:
                        tick_interval = 0.032 if eco_active else 0.020
                        if silence_ticks % 600 == 0:
                            gc.collect()
                    elif silence_ticks > 35:
                        tick_interval = 0.018 if eco_active else 0.012
                else:
                    silence_ticks = 0

                # 5. Telemetry: accumulate every tick, dispatch at 20 Hz (5 Hz below -60 dBFS)
                out_peak = input_peak * att
                if input_peak > acc_peak:
                    acc_peak = input_peak
                if out_peak > acc_out:
                    acc_out = out_peak
                if ch0 > acc_ch0:
                    acc_ch0 = ch0
                if ch1 > acc_ch1:
                    acc_ch1 = ch1
                if self.gain_reduction_db < acc_gr:
                    acc_gr = self.gain_reduction_db
                if self.is_limiting:
                    acc_limiting = True

                elapsed = perf_counter() - now
                is_quiet = input_peak < SILENCE_PEAK and not self.is_limiting
                interval = TELEMETRY_IDLE_SEC if is_quiet else TELEMETRY_ACTIVE_SEC
                if self.telemetry_callback and ((now - last_tele_time >= interval) or (was_quiet and not is_quiet)):
                    last_tele_time = now
                    tele["peak"] = acc_peak
                    tele["output_peak"] = acc_out
                    tele_ch[0] = acc_ch0
                    tele_ch[1] = acc_ch1
                    tele["gain_reduction_db"] = acc_gr
                    tele["active_target"] = self.active_session_name
                    tele["is_game_isolated"] = self.is_session_mode
                    tele["is_limiting"] = acc_limiting
                    tele["is_app_running"] = self.is_app_running
                    tele["auto_watch_status"] = self.auto_watch_status
                    tele["poll_latency_ms"] = round(elapsed * 1000.0, 2)
                    tele["mmcss_active"] = mmcss_active
                    tele["device_name"] = self.active_device_name
                    tele["eco_mode"] = eco_active
                    tele["audio_test_active"] = bool(test_pids)
                    tele["hearing_safe"] = hearing_safe
                    try:
                        self.telemetry_callback(tele)
                    except Exception:
                        pass
                    acc_peak = 0.0
                    acc_out = 0.0
                    acc_ch0 = 0.0
                    acc_ch1 = 0.0
                    acc_gr = 0.0
                    acc_limiting = False
                was_quiet = is_quiet

                sleep_time = tick_interval - elapsed
                if sleep_time > 0:
                    sleep(sleep_time)

        finally:
            try:
                if vol_endpoint is not None and self._master_touched:
                    vol_endpoint.SetMasterVolumeLevelScalar(self.user_target_master_vol, guid)
            except Exception:
                pass
            for i in range(len(t_vols)):
                try:
                    t_vols[i].SetMasterVolume(t_bases[i], None)
                except Exception:
                    pass
            release_master_device()
