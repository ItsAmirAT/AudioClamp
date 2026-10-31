"""Footstep Boost: make only the game louder using Windows volume controls.

A volume-based limiter can only turn sound down, so on its own it can never make footsteps
louder. Footstep Boost raises the master endpoint by B dB and lowers every other audio session
(Discord, browser, system sounds) by the same B dB, so they sound exactly as before and only the
clamped game gets louder. The limiter's ceiling is lowered by the same B dB at the same time, so
loud sounds land where they did before while quiet sounds such as footsteps gain B dB.

Every change is undone relative to the current level rather than restored to a snapshot, so
volume adjustments the user makes while the boost is active survive. A small recovery file
records what was applied, so a crash or forced exit cannot leave the PC unbalanced.
"""
import json
import os
import threading
from typing import Any, Dict, List, Optional, Tuple

from pycaw.pycaw import ISimpleAudioVolume

MAX_BOOST_DB = 12.0
_LEVEL_TOLERANCE_DB = 0.2


class FootstepBoost:
    def __init__(self, guid: Any, recovery_path: str):
        self.guid = guid
        self.recovery_path = recovery_path
        self.lock = threading.Lock()
        self.applied_db: float = 0.0
        self.requested_db: float = 0.0
        self._endpoint: Any = None
        self._device_id: str = ""
        self._master_base_db: Optional[float] = None
        self._last_written_db: Optional[float] = None
        # session instance id -> (ISimpleAudioVolume, linear factor currently applied)
        self._others: Dict[str, Tuple[Any, float]] = {}

    @property
    def active(self) -> bool:
        return self.applied_db > 0.0 or bool(self._others)

    # ------------------------------------------------------------------
    def update(self, endpoint: Any, device_id: str, other_sessions: List[Tuple[str, Any]],
               requested_db: float) -> float:
        """Apply or adjust the boost. other_sessions holds (instance_id, IAudioSessionControl2)
        for every session that is NOT being clamped. Returns the boost actually applied in dB."""
        with self.lock:
            self.requested_db = max(0.0, min(MAX_BOOST_DB, float(requested_db)))
            if self.requested_db <= 0.0 or endpoint is None:
                self._deactivate_locked()
                return 0.0
            if self._endpoint is not None and device_id != self._device_id:
                # Default device changed: put the old one back before boosting the new one
                self._deactivate_locked()

            cur_db = float(endpoint.GetMasterVolumeLevel())
            _min_db, max_db, _step = endpoint.GetVolumeRange()
            if self._master_base_db is None:
                self._master_base_db = cur_db
            elif self._last_written_db is not None and abs(cur_db - self._last_written_db) > _LEVEL_TOLERANCE_DB:
                # The user moved the master slider while boosted; keep their new level
                self._master_base_db = cur_db - self.applied_db

            target_db = max(0.0, min(self.requested_db, float(max_db) - self._master_base_db))
            write_db = self._master_base_db + target_db
            if self._last_written_db is None or abs(write_db - self._last_written_db) > 0.05:
                endpoint.SetMasterVolumeLevel(write_db, self.guid)
                self._last_written_db = write_db
            self._endpoint = endpoint
            self._device_id = device_id
            self.applied_db = target_db

            factor = 10.0 ** (-target_db / 20.0)
            seen = set()
            for key, ctl in other_sessions:
                seen.add(key)
                entry = self._others.get(key)
                try:
                    if entry is None:
                        vol = ctl.QueryInterface(ISimpleAudioVolume)
                        cur = float(vol.GetMasterVolume())
                        vol.SetMasterVolume(max(0.0, min(1.0, cur * factor)), self.guid)
                        self._others[key] = (vol, factor)
                    elif abs(entry[1] - factor) > 1e-4:
                        vol, old_factor = entry
                        cur = float(vol.GetMasterVolume())
                        vol.SetMasterVolume(max(0.0, min(1.0, cur / old_factor * factor)), self.guid)
                        self._others[key] = (vol, factor)
                except Exception:
                    pass
            # Sessions that ended need no restoring
            for key in [k for k in self._others if k not in seen]:
                self._others.pop(key, None)

            self._write_recovery_locked()
            return self.applied_db

    def deactivate(self) -> None:
        with self.lock:
            self._deactivate_locked()

    def _deactivate_locked(self) -> None:
        endpoint = self._endpoint
        if endpoint is not None and self.applied_db > 0.0:
            try:
                cur_db = float(endpoint.GetMasterVolumeLevel())
                base_db = cur_db - self.applied_db
                if self._last_written_db is not None and abs(cur_db - self._last_written_db) <= _LEVEL_TOLERANCE_DB:
                    base_db = self._master_base_db if self._master_base_db is not None else base_db
                min_db, _max_db, _step = endpoint.GetVolumeRange()
                endpoint.SetMasterVolumeLevel(max(float(min_db), base_db), self.guid)
            except Exception:
                pass
        for vol, factor in self._others.values():
            try:
                cur = float(vol.GetMasterVolume())
                vol.SetMasterVolume(max(0.0, min(1.0, cur / factor)), self.guid)
            except Exception:
                pass
        self._others.clear()
        self.applied_db = 0.0
        self._endpoint = None
        self._master_base_db = None
        self._last_written_db = None
        self._clear_recovery()

    # ------------------------------------------------------------------
    # Crash recovery
    # ------------------------------------------------------------------
    def _write_recovery_locked(self) -> None:
        state = {
            "device_id": self._device_id,
            "boost_db": self.applied_db,
            "sessions": {key: factor for key, (_vol, factor) in self._others.items()},
        }
        try:
            with open(self.recovery_path, "w", encoding="utf-8") as f:
                json.dump(state, f)
        except Exception:
            pass

    def _clear_recovery(self) -> None:
        try:
            if os.path.exists(self.recovery_path):
                os.remove(self.recovery_path)
        except Exception:
            pass

    def recover_after_crash(self, endpoint: Any, device_id: str, sessions: List[Tuple[str, Any]]) -> bool:
        """Undo a boost left behind by a previous run that did not exit cleanly."""
        if not os.path.exists(self.recovery_path):
            return False
        try:
            with open(self.recovery_path, "r", encoding="utf-8") as f:
                state = json.load(f)
        except Exception:
            self._clear_recovery()
            return False
        boost_db = float(state.get("boost_db", 0.0))
        if endpoint is not None and boost_db > 0.0 and state.get("device_id") == device_id:
            try:
                min_db, _max_db, _step = endpoint.GetVolumeRange()
                cur_db = float(endpoint.GetMasterVolumeLevel())
                endpoint.SetMasterVolumeLevel(max(float(min_db), cur_db - boost_db), self.guid)
            except Exception:
                pass
        factors: Dict[str, float] = state.get("sessions", {})
        for key, ctl in sessions:
            factor = factors.get(key)
            if not factor:
                continue
            try:
                vol = ctl.QueryInterface(ISimpleAudioVolume)
                cur = float(vol.GetMasterVolume())
                vol.SetMasterVolume(max(0.0, min(1.0, cur / factor)), self.guid)
            except Exception:
                pass
        self._clear_recovery()
        return True
