import sys, time, math, pathlib
sys.path.insert(0, sys.argv[1] if len(sys.argv) > 1 else str(pathlib.Path(__file__).resolve().parent.parent))
from core.audio_engine import AudioEngine, RELEASE_FLOOR_SEC
from core.config_manager import DEFAULT_CONFIG

class StubConfig:
    def __init__(self, **over):
        self.config = dict(DEFAULT_CONFIG); self.config.update(over); self.revision = 0
    def get(self, k, d=None): return self.config.get(k, d)
    def set(self, k, v, save=True): self.config[k] = v; self.revision += 1
    def apply_profile(self, n): pass
    def save_recovery_state(self, *a): pass

e = AudioEngine(StubConfig())
# DSP invariants from testing.md
att, gr = e._compute_soft_knee_attenuation(0.70, -12.0, "soft_knee", 5.0, 4.0)
assert att < 1.0 and gr < 0.0
assert e._compute_soft_knee_attenuation(0.00001, -12.0, "soft_knee", 5.0, 4.0) == (1.0, 0.0)
# true 4:1 above the knee: input -3 dB, T=-12 -> output -12 + 9/4 = -9.75 -> GR -6.75
att, gr = e._compute_soft_knee_attenuation(10**(-3/20), -12.0, "soft_knee", 5.0, 4.0)
assert abs(gr + 6.75) < 1e-9, gr
# knee continuity at T+W/2
a = e._compute_soft_knee_attenuation(10**((-12+2.5-1e-9)/20), -12, "soft_knee", 5, 4)[1]
b = e._compute_soft_knee_attenuation(10**((-12+2.5+1e-9)/20), -12, "soft_knee", 5, 4)[1]
assert abs(a-b) < 1e-6
print("soft-knee 4:1 + silence pass-through: OK")

# Two-stage release: simulate recovery from -12 dB at 3 ms ticks, release 130 ms
def recover(release_ms, start_db=-12.0):
    g = 10**(start_db/20); t = 0.0; t3 = None
    while g < 0.995:
        g2 = AudioEngine._release_step(g, 1.0, 0.003, release_ms)
        assert g2 >= g  # release never reduces gain
        g = g2; t += 0.003
        if t3 is None and 20*math.log10(g) > -3.0: t3 = t
    return t3*1000, t*1000
fast, total = recover(130)
print(f"release 130ms: -12 -> -3 dB in {fast:.0f} ms, full recovery {total:.0f} ms")
# floor: even release_ms=10 never goes below 40 ms tau
g = 0.5; g2 = AudioEngine._release_step(g, 1.0, 0.003, 10)
assert abs((g2-g) - (1-g)*(1-math.exp(-0.003/RELEASE_FLOOR_SEC))) < 1e-12
print("40 ms release floor holds: OK")

# Live loops
def run(label, secs, **over):
    eng = AudioEngine(StubConfig(auto_profile_switch=False, **over))
    stamps = []
    eng.telemetry_callback = lambda d: stamps.append((time.perf_counter(), d["peak"], d["poll_latency_ms"]))
    eng.start(); time.sleep(secs); eng.stop()
    alive = eng.thread.is_alive()
    gaps = [b[0]-a[0] for a, b in zip(stamps, stamps[1:])]
    avg = sum(gaps)/len(gaps)*1000 if gaps else float('nan')
    mx = max((s[1] for s in stamps), default=0)
    print(f"{label}: {len(stamps)} telemetry events in {secs}s (avg gap {avg:.0f} ms), max peak {mx:.4f}, device='{eng.active_device_name}', master_touched={eng._master_touched}, thread_alive_after_stop={alive}")
run("standby (auto_game, no game)", 2.0, target_mode="auto_game")
run("master meter, limiter disabled", 2.0, target_mode="master_device", enabled=False)

t = time.perf_counter(); streams = AudioEngine(StubConfig()).sample_audio_streams()
print(f"stream scan {1000*(time.perf_counter()-t):.0f} ms:", [(s['name'], s['peak_db'], s['producing_sound']) for s in streams][:8])
