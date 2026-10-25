let state = {
  enabled: true,
  target_mode: "auto_game",
  threshold_db: -12.0,
  threshold_percent: 50.0,
  knee_mode: "soft_knee",
  knee_width_db: 6.0,
  release_ms: 120,
  active_profile: "PUBG: BATTLEGROUNDS",
  active_target: "Master Audio",
  is_game_isolated: false,
  peak: 0.0,
  channel_peaks: [0.0, 0.0],
  gain_reduction_db: 0.0,
  applied_vol: 0.5,
  target_process: ""
};

const canvas = document.getElementById("meterCanvas");
const ctx = canvas.getContext("2d", { alpha: true });

let canvasCssW = 0;
let canvasCssH = 0;
let smoothPeaks = [0.0, 0.0];
let peakHolds = [0.0, 0.0];
let peakHoldTimes = [0, 0];
let smoothGR = 0.0;
let isDraggingCeiling = false;
let lastRenderTime = performance.now();
let lastTextUpdateTime = 0;

function updateCanvasDimensions() {
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;

  canvasCssW = rect.width;
  canvasCssH = rect.height;

  const targetW = Math.round(rect.width * dpr);
  const targetH = Math.round(rect.height * dpr);

  if (canvas.width !== targetW || canvas.height !== targetH) {
    canvas.width = targetW;
    canvas.height = targetH;
  }

  ctx.resetTransform();
  ctx.scale(dpr, dpr);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
}

const resizeObserver = new ResizeObserver(() => {
  updateCanvasDimensions();
});
resizeObserver.observe(canvas);
window.addEventListener("resize", updateCanvasDimensions);

function renderMeter(now) {
  requestAnimationFrame(renderMeter);

  if (!now) now = performance.now();
  const dt = Math.min(0.08, Math.max(0.001, (now - lastRenderTime) / 1000.0));
  lastRenderTime = now;

  const w = canvasCssW;
  const h = canvasCssH;
  if (w <= 10 || h <= 10) return;

  ctx.clearRect(0, 0, w, h);

  const padTop = 18;
  const padBottom = 24;
  const padLeft = 44;
  const padRight = 80;
  const meterH = Math.max(10, h - padTop - padBottom);
  const availW = Math.max(10, w - padLeft - padRight);

  const minDb = -36.0;
  const maxDb = 0.0;

  function dbToY(db) {
    const clamped = Math.max(minDb, Math.min(maxDb, db));
    const norm = (clamped - minDb) / (maxDb - minDb);
    return padTop + (1.0 - norm) * meterH;
  }

  function scalarToY(scalar) {
    if (scalar <= 0.0001) return padTop + meterH;
    const db = 20.0 * Math.log10(Math.max(0.0001, scalar));
    return dbToY(db);
  }

  const dbTicks = [0, -6, -12, -18, -24, -30, -36];
  ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
  ctx.fillStyle = "#94a3b8";
  ctx.font = "700 9.5px 'Segoe UI Variable Text', -apple-system, BlinkMacSystemFont, sans-serif";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";

  dbTicks.forEach(db => {
    const y = Math.round(dbToY(db)) + 0.5;
    ctx.beginPath();
    ctx.setLineDash([2, 3]);
    ctx.moveTo(padLeft - 4, y);
    ctx.lineTo(padLeft + availW, y);
    ctx.stroke();
    ctx.fillText(`${db}`, padLeft - 8, y);
  });
  ctx.setLineDash([]);

  if (state.knee_mode === "soft_knee") {
    const kneeTopY = dbToY(state.threshold_db + state.knee_width_db / 2.0);
    const kneeBotY = dbToY(state.threshold_db - state.knee_width_db / 2.0);
    const kneeH = Math.max(2, kneeBotY - kneeTopY);

    ctx.fillStyle = "rgba(0, 242, 254, 0.06)";
    ctx.fillRect(padLeft, kneeTopY, availW, kneeH);

    ctx.strokeStyle = "rgba(0, 242, 254, 0.3)";
    ctx.setLineDash([3, 3]);
    ctx.strokeRect(padLeft, kneeTopY, availW, kneeH);
    ctx.setLineDash([]);

    ctx.fillStyle = "rgba(0, 242, 254, 0.85)";
    ctx.font = "800 8.5px 'Segoe UI Variable Text', sans-serif";
    ctx.textAlign = "left";
    ctx.fillText("DISTANCE DYNAMICS ZONE (SOFT-KNEE 4:1)", padLeft + 8, kneeBotY - 4);
  }

  const numCh = Math.min(6, state.channel_peaks.length);
  const barGap = 18;
  const barW = Math.max(28, Math.floor((availW - (numCh - 1) * barGap) / numCh));
  const chNames = ["LEFT (L)", "RIGHT (R)", "CENTER", "LFE", "SURROUND L", "SURROUND R"];

  const numSegments = 32;
  const segHeight = Math.floor((meterH - (numSegments - 1) * 2) / numSegments);

  for (let i = 0; i < numCh; i++) {
    const bx = padLeft + i * (barW + barGap);
    const targetVal = state.channel_peaks[i] || 0.0;

    const alpha = 1.0 - Math.exp(-dt / 0.045);
    smoothPeaks[i] = (smoothPeaks[i] || 0) + (targetVal - (smoothPeaks[i] || 0)) * alpha;
    const dispVal = Math.max(0.0, Math.min(1.5, smoothPeaks[i]));

    if (targetVal >= (peakHolds[i] || 0)) {
      peakHolds[i] = targetVal;
      peakHoldTimes[i] = now;
    } else if (now - (peakHoldTimes[i] || 0) > 1200) {
      peakHolds[i] = Math.max(0.0, peakHolds[i] - 0.02);
    }

    ctx.fillStyle = "rgba(10, 15, 26, 0.9)";
    ctx.fillRect(bx, padTop, barW, meterH);
    ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
    ctx.strokeRect(bx, padTop, barW, meterH);

    const activeTopY = scalarToY(dispVal);
    const threshY = dbToY(state.threshold_db);

    for (let s = 0; s < numSegments; s++) {
      const sy = padTop + meterH - (s + 1) * (segHeight + 2);
      const isLit = sy >= activeTopY;

      if (isLit) {
        if (sy < threshY) {
          ctx.fillStyle = "#ff2a5f";
        } else if (sy < dbToY(-12)) {
          ctx.fillStyle = "#f59e0b";
        } else {
          ctx.fillStyle = "#10b981";
        }
      } else {
        ctx.fillStyle = "rgba(255, 255, 255, 0.035)";
      }

      ctx.fillRect(bx + 2, sy, barW - 4, segHeight);
    }

    if (peakHolds[i] > 0.01) {
      const pkY = Math.round(scalarToY(peakHolds[i])) + 0.5;
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(bx + 1, pkY);
      ctx.lineTo(bx + barW - 1, pkY);
      ctx.stroke();
      ctx.lineWidth = 1;
    }

    ctx.fillStyle = "#94a3b8";
    ctx.font = "800 8.5px 'Segoe UI Variable Text', sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(chNames[i] || `CH${i+1}`, bx + barW / 2, padTop + meterH + 15);
  }

  const threshY = Math.round(dbToY(state.threshold_db)) + 0.5;
  ctx.strokeStyle = "#ff2a5f";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(padLeft - 2, threshY);
  ctx.lineTo(padLeft + availW + 2, threshY);
  ctx.stroke();

  const badgeW = 84;
  const badgeH = 20;
  const badgeX = padLeft + availW - badgeW - 6;
  const badgeY = Math.round(threshY - badgeH / 2);

  ctx.fillStyle = "rgba(14, 20, 36, 0.96)";
  ctx.strokeStyle = "#ff2a5f";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.roundRect(badgeX, badgeY, badgeW, badgeH, 5);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = "#ff2a5f";
  ctx.font = "800 9.5px 'Segoe UI Variable Text', sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(`LIMIT: ${state.threshold_db.toFixed(1)} dB`, badgeX + badgeW / 2, threshY);

  const grX = padLeft + availW + 16;
  const grW = 22;

  ctx.fillStyle = "#090d18";
  ctx.fillRect(grX, padTop, grW, meterH);
  ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
  ctx.strokeRect(grX, padTop, grW, meterH);

  const grAlpha = 1.0 - Math.exp(-dt / 0.06);
  smoothGR = smoothGR + (Math.abs(state.gain_reduction_db) - smoothGR) * grAlpha;
  if (smoothGR > 0.05) {
    const grNorm = Math.min(1.0, smoothGR / 30.0);
    const grFillH = grNorm * meterH;

    const grGrad = ctx.createLinearGradient(0, padTop, 0, padTop + grFillH);
    grGrad.addColorStop(0, "#f59e0b");
    grGrad.addColorStop(1, "#ff2a5f");

    ctx.fillStyle = grGrad;
    ctx.fillRect(grX + 2, padTop + 1, grW - 4, grFillH);
  }

  ctx.fillStyle = "#94a3b8";
  ctx.font = "800 8.5px 'Segoe UI Variable Text', sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("LIMIT GR", grX + grW / 2, padTop - 6);

  ctx.fillStyle = smoothGR > 0.5 ? "#ff2a5f" : "#64748b";
  ctx.fillText(`${smoothGR > 0.1 ? `-${smoothGR.toFixed(1)}` : "0.0"} dB`, grX + grW / 2, padTop + meterH + 15);
}

canvas.addEventListener("mousedown", (e) => {
  const rect = canvas.getBoundingClientRect();
  const y = e.clientY - rect.top;
  const threshY = (function() {
    const minDb = -36.0, maxDb = 0.0, padTop = 18, meterH = rect.height - padTop - 24;
    const clamped = Math.max(minDb, Math.min(maxDb, state.threshold_db));
    return padTop + (1.0 - (clamped - minDb) / (maxDb - minDb)) * meterH;
  })();

  if (Math.abs(y - threshY) < 14) {
    isDraggingCeiling = true;
  }
});

window.addEventListener("mousemove", (e) => {
  if (!isDraggingCeiling) return;
  const rect = canvas.getBoundingClientRect();
  const y = e.clientY - rect.top;
  const padTop = 18;
  const meterH = rect.height - padTop - 24;
  const norm = Math.max(0, Math.min(1, 1.0 - (y - padTop) / meterH));
  const newDb = -36.0 + norm * 36.0;
  updateCeiling(newDb);
});

window.addEventListener("mouseup", () => {
  isDraggingCeiling = false;
});

function updateSliderTrack(slider, color) {
  const min = parseFloat(slider.min);
  const max = parseFloat(slider.max);
  const val = parseFloat(slider.value);
  const pct = Math.max(0, Math.min(100, ((val - min) / (max - min)) * 100));
  slider.style.background = `linear-gradient(to right, ${color} 0%, ${color} ${pct}%, #141b2b ${pct}%, #141b2b 100%)`;
}

function updateCeiling(db) {
  state.threshold_db = Math.max(-30.0, Math.min(0.0, db));
  const pct = Math.pow(10, state.threshold_db / 20.0) * 100.0;
  state.threshold_percent = pct;

  const slider = document.getElementById("ceilingSlider");
  slider.value = state.threshold_db;
  updateSliderTrack(slider, "#ff2a5f");

  document.getElementById("ceilingReadout").innerText = `${state.threshold_db.toFixed(1)} dBFS (${pct.toFixed(0)}%)`;

  if (window.pywebview && window.pywebview.api) {
    window.pywebview.api.set_threshold(state.threshold_db);
  }
}

function setCeilingDb(db) {
  updateCeiling(db);
}

document.getElementById("ceilingSlider").addEventListener("input", (e) => {
  updateCeiling(parseFloat(e.target.value));
});

document.getElementById("powerSwitch").addEventListener("change", (e) => {
  const enabled = e.target.checked;
  state.enabled = enabled;
  const dot = document.getElementById("powerDot");
  const text = document.getElementById("powerStatusText");

  text.innerText = enabled ? "LIMITER ACTIVE" : "BYPASSED (OFF)";
  text.style.color = enabled ? "var(--accent-emerald)" : "var(--accent-crimson)";
  dot.style.backgroundColor = enabled ? "var(--accent-emerald)" : "var(--accent-crimson)";
  dot.style.boxShadow = enabled ? "0 0 8px var(--accent-emerald)" : "0 0 8px var(--accent-crimson)";

  if (window.pywebview && window.pywebview.api) {
    window.pywebview.api.toggle_enabled(enabled);
  }
});

document.getElementById("kneeSwitch").addEventListener("change", (e) => {
  state.knee_mode = e.target.checked ? "soft_knee" : "brickwall";
  if (window.pywebview && window.pywebview.api) {
    window.pywebview.api.set_knee_mode(state.knee_mode);
  }
});

const releaseSlider = document.getElementById("releaseSlider");
releaseSlider.addEventListener("input", (e) => {
  const val = parseInt(e.target.value);
  state.release_ms = val;
  document.getElementById("releaseNum").innerText = `${val} ms`;
  updateSliderTrack(releaseSlider, "#00f2fe");

  if (window.pywebview && window.pywebview.api) {
    window.pywebview.api.set_release_ms(val);
  }
});

function setScope(mode) {
  state.target_mode = mode;
  document.querySelectorAll(".scope-btn").forEach(btn => btn.classList.remove("active"));
  if (mode === "auto_game") document.getElementById("btnScopeAuto").classList.add("active");
  if (mode === "specific_app") document.getElementById("btnScopeApp").classList.add("active");
  if (mode === "master_device") document.getElementById("btnScopeMaster").classList.add("active");

  const drawer = document.getElementById("customAppDrawer");
  if (drawer) {
    if (mode === "specific_app") {
      drawer.style.display = "flex";
      refreshAudioProcesses();
    } else {
      drawer.style.display = "none";
    }
  }

  if (window.pywebview && window.pywebview.api) {
    window.pywebview.api.set_scope(mode);
  }
}

async function refreshAudioProcesses() {
  const dropdown = document.getElementById("processDropdown");
  if (!dropdown) return;
  dropdown.innerHTML = '<option value="">Scanning Active Audio Games/Apps...</option>';

  if (window.pywebview && window.pywebview.api && window.pywebview.api.get_audio_processes) {
    try {
      const procs = await window.pywebview.api.get_audio_processes();
      dropdown.innerHTML = '<option value="">-- Choose Active Audio Game/App --</option>';
      if (procs && procs.length > 0) {
        procs.forEach(proc => {
          const opt = document.createElement("option");
          opt.value = proc;
          opt.textContent = `🎮 ${proc}`;
          if (state.target_process && proc.toLowerCase() === state.target_process.toLowerCase()) {
            opt.selected = true;
          }
          dropdown.appendChild(opt);
        });
      } else {
        const opt = document.createElement("option");
        opt.disabled = true;
        opt.textContent = "No audio games detected (start game or use Browse)";
        dropdown.appendChild(opt);
      }
    } catch (e) {
      dropdown.innerHTML = '<option value="">-- Manual .exe Input Below --</option>';
    }
  }
}

function onProcessDropdownSelect(procName) {
  if (!procName) return;
  state.target_process = procName;
  const input = document.getElementById("customProcessInput");
  if (input) input.value = procName;
  if (window.pywebview && window.pywebview.api && window.pywebview.api.set_custom_process) {
    window.pywebview.api.set_custom_process(procName);
  }
}

function onManualProcessInput(procName) {
  const clean = procName.trim();
  if (!clean) return;
  state.target_process = clean;
  if (window.pywebview && window.pywebview.api && window.pywebview.api.set_custom_process) {
    window.pywebview.api.set_custom_process(clean);
  }
}

async function browseExeFile() {
  if (window.pywebview && window.pywebview.api && window.pywebview.api.browse_for_exe) {
    const exeName = await window.pywebview.api.browse_for_exe();
    if (exeName) {
      state.target_process = exeName;
      const input = document.getElementById("customProcessInput");
      if (input) input.value = exeName;
      await refreshAudioProcesses();
      const dropdown = document.getElementById("processDropdown");
      if (dropdown) dropdown.value = exeName;
    }
  }
}

function applyProfile(profileName) {
  state.active_profile = profileName;
  document.querySelectorAll(".profile-card").forEach(c => c.classList.remove("active"));
  if (event && event.currentTarget) {
    event.currentTarget.classList.add("active");
  }

  if (window.pywebview && window.pywebview.api) {
    window.pywebview.api.apply_profile(profileName);
  }
}

function emergencyReset() {
  updateCeiling(0.0);
  if (window.pywebview && window.pywebview.api) {
    window.pywebview.api.emergency_reset();
  }
}

function minimizeWindow() {
  if (window.pywebview && window.pywebview.api) window.pywebview.api.minimize_window();
}

function toggleMaximize() {
  if (window.pywebview && window.pywebview.api) window.pywebview.api.toggle_maximize();
}

function closeWindow() {
  if (window.pywebview && window.pywebview.api) window.pywebview.api.close_window();
}

function openDonationLink() {
  if (window.pywebview && window.pywebview.api && window.pywebview.api.open_donation_link) {
    window.pywebview.api.open_donation_link();
  } else {
    window.open("https://ko-fi.com/itsspero", "_blank");
  }
}

window.receiveTelemetry = function(data) {
  state.peak = data.peak || 0.0;
  state.channel_peaks = data.channel_peaks || [state.peak, state.peak];
  state.gain_reduction_db = data.gain_reduction_db || 0.0;

  if (state.active_target !== data.active_target || state.is_game_isolated !== data.is_game_isolated) {
    state.active_target = data.active_target || "Master Audio";
    state.is_game_isolated = data.is_game_isolated || false;

    const banner = document.getElementById("targetBannerText");
    const badge = document.getElementById("discordBadge");
    if (banner) banner.innerText = `Target: ${state.active_target}`;
    if (badge) {
      badge.innerText = state.is_game_isolated ? "🛡️ Discord Safe" : "🔊 Entire PC";
      badge.style.background = state.is_game_isolated ? "rgba(16, 185, 129, 0.15)" : "rgba(245, 158, 11, 0.15)";
      badge.style.borderColor = state.is_game_isolated ? "rgba(16, 185, 129, 0.35)" : "rgba(245, 158, 11, 0.35)";
      badge.style.color = state.is_game_isolated ? "#10b981" : "#f59e0b";
    }
  }

  const now = performance.now();
  if (now - lastTextUpdateTime > 50) {
    lastTextUpdateTime = now;

    const pkDb = 20.0 * Math.log10(Math.max(0.0001, state.peak));
    const pkReadout = document.getElementById("peakReadout");
    if (pkReadout) {
      pkReadout.innerText = `${pkDb.toFixed(1)} dBFS (${(state.peak * 100).toFixed(0)}%)`;
    }

    const grReadout = document.getElementById("grReadout");
    if (grReadout) {
      grReadout.innerText = Math.abs(state.gain_reduction_db) > 0.1 ? `-${Math.abs(state.gain_reduction_db).toFixed(1)} dB` : "0.0 dB";
    }
  }
};

window.receiveInitialConfig = function(cfg) {
  state.enabled = cfg.enabled ?? true;
  state.threshold_db = cfg.threshold_db ?? -12.0;
  state.threshold_percent = cfg.threshold_percent ?? 50.0;
  state.knee_mode = cfg.knee_mode ?? "soft_knee";
  state.release_ms = cfg.release_ms ?? 120;
  state.target_mode = cfg.target_mode ?? "auto_game";

  document.getElementById("powerSwitch").checked = state.enabled;
  const dot = document.getElementById("powerDot");
  const text = document.getElementById("powerStatusText");
  text.innerText = state.enabled ? "LIMITER ACTIVE" : "BYPASSED (OFF)";
  text.style.color = state.enabled ? "var(--accent-emerald)" : "var(--accent-crimson)";
  dot.style.backgroundColor = state.enabled ? "var(--accent-emerald)" : "var(--accent-crimson)";
  dot.style.boxShadow = state.enabled ? "0 0 8px var(--accent-emerald)" : "0 0 8px var(--accent-crimson)";

  const cSlider = document.getElementById("ceilingSlider");
  cSlider.value = state.threshold_db;
  updateSliderTrack(cSlider, "#ff2a5f");
  document.getElementById("ceilingReadout").innerText = `${state.threshold_db.toFixed(1)} dBFS (${state.threshold_percent.toFixed(0)}%)`;

  document.getElementById("kneeSwitch").checked = (state.knee_mode === "soft_knee");

  const rSlider = document.getElementById("releaseSlider");
  rSlider.value = state.release_ms;
  updateSliderTrack(rSlider, "#00f2fe");
  document.getElementById("releaseNum").innerText = `${state.release_ms} ms`;

  state.target_process = cfg.target_process || "";
  const pInput = document.getElementById("customProcessInput");
  if (pInput) pInput.value = state.target_process;

  setScope(state.target_mode);
};

function initWindowDrag() {
  const titlebar = document.querySelector(".titlebar");
  if (!titlebar) return;

  let isDragging = false;
  let startX = 0;
  let startY = 0;

  titlebar.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    if (e.target.closest(".titlebar-controls") || e.target.closest("button") || e.target.closest("input")) {
      return;
    }
    isDragging = true;
    startX = e.clientX;
    startY = e.clientY;
    try {
      titlebar.setPointerCapture(e.pointerId);
    } catch (_) {}
  });

  titlebar.addEventListener("pointermove", (e) => {
    if (!isDragging) return;
    const newX = e.screenX - startX;
    const newY = e.screenY - startY;
    if (window.pywebview && window.pywebview.api && window.pywebview.api.move_window) {
      window.pywebview.api.move_window(newX, newY);
    } else if (window.pywebview && window.pywebview._jsApiCallback) {
      window.pywebview._jsApiCallback("pywebviewMoveWindow", [newX, newY], "move");
    }
  });

  const stopDrag = (e) => {
    if (isDragging) {
      isDragging = false;
      try {
        titlebar.releasePointerCapture(e.pointerId);
      } catch (_) {}
    }
  };

  titlebar.addEventListener("pointerup", stopDrag);
  titlebar.addEventListener("pointercancel", stopDrag);
}

window.addEventListener("DOMContentLoaded", () => {
  updateCanvasDimensions();
  renderMeter();
  initWindowDrag();
  updateSliderTrack(document.getElementById("ceilingSlider"), "#ff2a5f");
  updateSliderTrack(document.getElementById("releaseSlider"), "#00f2fe");
});
