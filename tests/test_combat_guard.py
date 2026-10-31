"""Two 3-round bursts 1.8 s apart, footsteps (-30 dBFS) in between, 28 ms meter refresh.
Mirrors the engine's attack / hold / release / Combat Guard logic using its DSP helpers."""
import sys, math, pathlib
sys.path.insert(0, sys.argv[1] if len(sys.argv) > 1 else str(pathlib.Path(__file__).resolve().parent.parent))
from core.audio_engine import AudioEngine, COMBAT_GUARD_TRIGGER_DB

eng = AudioEngine.__new__(AudioEngine)
T_DB, REL_MS = -16.5, 130.0
BURSTS = [0.2, 2.0]
SHOT_TIMES = [b + k * 0.086 for b in BURSTS for k in range(3)]
STEP_TIMES = [0.9, 1.3, 1.7]


def signal(t):
    lvl = 0.0005
    for ts in SHOT_TIMES:
        if t >= ts:
            lvl = max(lvl, 10 ** (-0.5 / 20) * math.exp(-(t - ts) / 0.040))
    for ts in STEP_TIMES:
        if ts <= t < ts + 0.06:
            lvl = max(lvl, 10 ** (-30 / 20))
    return lvl


def run(guard_db):
    guard_lin = 10 ** (-guard_db / 20)
    g, hold, meter, block, guard_until = 1.0, 0.0, 0.0, 0.0, 0.0
    t, next_meter, next_poll, out = 0.0, 0.028, 0.0, []
    while t < 3.0:
        x = signal(t)
        block = max(block, x)
        if t >= next_meter:
            meter, block, next_meter = block, 0.0, next_meter + 0.028
        if t >= next_poll:
            dt = 0.003
            next_poll += dt
            target, gr = eng._compute_soft_knee_attenuation(meter, T_DB, "soft_knee", 5.0, 4.0)
            if guard_db > 0 and gr <= COMBAT_GUARD_TRIGGER_DB:
                guard_until = t + 4.0
            guard_on = guard_db > 0 and t < guard_until
            if target < g:
                a = math.exp(-dt / 0.0004); g = g * a + target * (1 - a); hold = 0.037
            elif hold > 0:
                hold -= dt
            else:
                prev = g
                g = AudioEngine._release_step(g, target, dt, REL_MS, True)
                if guard_on:
                    g = min(g, max(prev, guard_lin))
                if g >= 0.995:
                    g = 1.0
        out.append((t, x * g))
        t += 0.001
    return out


db = lambda v: 20 * math.log10(max(v, 1e-6))
print(f"{'':16}{'no guard':>12}{'guard -4':>12}{'guard -8':>12}")
runs = [run(0), run(4), run(8)]
rows = [("1st shot, burst 1", BURSTS[0]), ("1st shot, burst 2", BURSTS[1])]
for label, ts in rows:
    print(f"{label:16}" + "".join(f"{db(max(v for t, v in r if ts <= t < ts + 0.010)):>9.1f} dB" for r in runs))
print(f"{'footsteps':16}" + "".join(f"{db(max(v for t, v in r if 1.3 <= t < 1.36)):>9.1f} dB" for r in runs))
