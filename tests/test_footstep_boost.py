"""Footstep Boost logic tests with fake Windows volume objects (no real audio is touched)."""
import os, sys, tempfile, pathlib
sys.path.insert(0, sys.argv[1] if len(sys.argv) > 1 else str(pathlib.Path(__file__).resolve().parent.parent))
from core.footstep_boost import FootstepBoost


class FakeEndpoint:
    def __init__(self, db, min_db=-65.25, max_db=0.0):
        self.db, self.min_db, self.max_db = db, min_db, max_db
    def GetMasterVolumeLevel(self): return self.db
    def SetMasterVolumeLevel(self, db, guid): self.db = db
    def GetVolumeRange(self): return (self.min_db, self.max_db, 0.03125)


class FakeVol:
    def __init__(self, v): self.v = v
    def GetMasterVolume(self): return self.v
    def SetMasterVolume(self, v, guid): self.v = v


class FakeCtl:
    def __init__(self, vol): self.vol = vol
    def QueryInterface(self, iface): return self.vol


def near(a, b, tol=1e-6): return abs(a - b) <= tol


rec = os.path.join(tempfile.mkdtemp(), "boost_recovery.json")
discord, browser = FakeVol(0.8), FakeVol(1.0)
others = [("discord", FakeCtl(discord)), ("browser", FakeCtl(browser))]
ep = FakeEndpoint(-20.0)
b = FootstepBoost("guid", rec)

# 1. Boost +6: master up 6 dB, other apps down 6 dB, recovery file written
assert near(b.update(ep, "dev1", others, 6.0), 6.0)
f6 = 10 ** (-6 / 20)
assert near(ep.db, -14.0) and near(discord.v, 0.8 * f6) and near(browser.v, f6)
assert os.path.exists(rec)

# 2. Re-running with the same request changes nothing
b.update(ep, "dev1", others, 6.0)
assert near(ep.db, -14.0) and near(discord.v, 0.8 * f6)

# 3. User moves master during boost (+2 dB): their change is kept as the new base
ep.db = -12.0
b.update(ep, "dev1", others, 6.0)
assert near(ep.db, -12.0) and near(b._master_base_db, -18.0)

# 4. User lowers Discord while boosted; turning the boost down to +3 keeps that relative change
discord.v = 0.25
b.update(ep, "dev1", others, 3.0)
f3 = 10 ** (-3 / 20)
assert near(ep.db, -15.0) and near(discord.v, 0.25 / f6 * f3)

# 5. A new app appears mid-boost and gets compensated too
game_chat = FakeVol(0.5)
others.append(("chat", FakeCtl(game_chat)))
b.update(ep, "dev1", others, 3.0)
assert near(game_chat.v, 0.5 * f3)

# 6. Deactivate: master and apps go back, keeping the user's own changes
b.deactivate()
assert near(ep.db, -18.0) and near(discord.v, 0.25 / f6) and near(browser.v, 1.0) and near(game_chat.v, 0.5)
assert not os.path.exists(rec) and not b.active

# 7. Headroom limit: master at -2 dB can only take +2
ep2 = FakeEndpoint(-2.0)
v = FakeVol(1.0)
assert near(b.update(ep2, "dev1", [("x", FakeCtl(v))], 6.0), 2.0)
assert near(ep2.db, 0.0) and near(v.v, 10 ** (-2 / 20))
b.deactivate()
assert near(ep2.db, -2.0) and near(v.v, 1.0)

# 8. Crash recovery: a fresh instance undoes what the dead one left behind
ep3 = FakeEndpoint(-30.0)
d3 = FakeVol(1.0)
crashed = FootstepBoost("guid", rec)
crashed.update(ep3, "dev1", [("d", FakeCtl(d3))], 6.0)   # process "dies" here without deactivate
assert near(ep3.db, -24.0) and os.path.exists(rec)
fresh = FootstepBoost("guid", rec)
assert fresh.recover_after_crash(ep3, "dev1", [("d", FakeCtl(d3))])
assert near(ep3.db, -30.0) and near(d3.v, 1.0) and not os.path.exists(rec)

# 9. Device switch while boosted: the old device is put back before the new one is boosted
old_ep, new_ep = FakeEndpoint(-20.0), FakeEndpoint(-25.0)
b.update(old_ep, "old", [], 6.0)
b.update(new_ep, "new", [], 6.0)
assert near(old_ep.db, -20.0) and near(new_ep.db, -19.0)
b.deactivate()
assert near(new_ep.db, -25.0)

# 10. Request 0 is a full undo
b.update(ep, "dev1", others, 0.0)
assert not b.active
print("Footstep Boost: all 10 scenarios passed")
