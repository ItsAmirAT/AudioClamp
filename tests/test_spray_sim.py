"""Simulate a 6-round spray through the limiter DSP with Windows' measured ~28 ms meter refresh.

Per-shot envelope: instant peak at -0.5 dBFS decaying (tau 40 ms) toward a -30 dBFS bed.
The meter reports the max of each 28 ms block only when the block ends.
"""
import sys, math, pathlib
sys.path.insert(0, sys.argv[1] if len(sys.argv) > 1 else str(pathlib.Path(__file__).resolve().parent.parent))
from core.audio_engine import AudioEngine, HEARING_SAFE_HOLD_SEC

eng = AudioEngine.__new__(AudioEngine)  # only the pure DSP helpers are used
DT, METER, SHOT_GAP, SHOTS = 0.001, 0.028, 0.086, 6
T_DB, RATIO, KNEE_W, REL_MS = -16.5, 4.0, 5.0, 130.0


def signal(t):
    lvl = 10 ** (-30 / 20)
    for k in range(SHOTS):
        ts = 0.2 + k * SHOT_GAP
        if t >= ts:
            lvl = max(lvl, 10 ** (-0.5 / 20) * math.exp(-(t - ts) / 0.040))
    return lvl


def run(safe):
    knee = "brickwall" if safe else "soft_knee"
    hold_dur = HEARING_SAFE_HOLD_SEC if safe else max(0.025, min(0.038, REL_MS / 3500))
    g, hold, meter_val, block_max = 1.0, 0.0, 0.0, 0.0
    out = []
    t, next_meter, next_poll = 0.0, METER, 0.0
    while t < 1.0:
        x = signal(t)
        block_max = max(block_max, x)
        if t >= next_meter:
            meter_val, block_max, next_meter = block_max, 0.0, next_meter + METER
        if t >= next_poll:  # 3 ms engine tick
            dt = 0.003
            next_poll += dt
            target, _ = eng._compute_soft_knee_attenuation(meter_val, T_DB, knee, KNEE_W, RATIO)
            if target < g:
                a = math.exp(-dt / 0.0004)
                g = g * a + target * (1 - a)
                hold = hold_dur
            elif hold > 0:
                hold -= dt
            else:
                g = AudioEngine._release_step(g, target, dt, REL_MS, not safe)
                if g >= 0.995:
                    g = 1.0
        out.append((t, x * g))
        t += DT
    return out


db = lambda v: 20 * math.log10(max(v, 1e-6))
res = {name: run(safe) for name, safe in (("default 4:1", False), ("hearing-safe", True))}
print(f"{'shot':>4} | " + " | ".join(f"{n:>26}" for n in res))
print(f"{'':>4} | " + " | ".join(f"{'first 10ms peak / 10-80ms':>26}" for _ in res))
for k in range(SHOTS):
    ts = 0.2 + k * SHOT_GAP
    cells = []
    for out in res.values():
        onset = max(v for t, v in out if ts <= t < ts + 0.010)
        body = max(v for t, v in out if ts + 0.010 <= t < ts + 0.080)
        cells.append(f"{db(onset):8.1f} dB / {db(body):6.1f} dB")
    print(f"{k + 1:>4} | " + " | ".join(f"{c:>26}" for c in cells))
for name, out in res.items():
    burst = [v for t, v in out if 0.2 <= t < 0.2 + SHOTS * SHOT_GAP]
    rms = math.sqrt(sum(v * v for v in burst) / len(burst))
    print(f"{name:>13}: burst energy {db(rms):.1f} dB RMS")
# footstep recovery: when gain is back within 1 dB after the last shot
for name, safe in (("default 4:1", False), ("hearing-safe", True)):
    pass
