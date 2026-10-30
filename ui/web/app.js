let state = {
  enabled: true,
  auto_watch_mode: true,
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
  output_peak: 0.0,
  channel_peaks: [0.0, 0.0],
  gain_reduction_db: 0.0,
  applied_vol: 0.5,
  target_process: "",
  monitored_apps: [],
  is_app_running: false,
  auto_watch_status: "Standby: Watching for Games",
  start_with_windows: false,
  eco_mode: false,
  device_name: "Default Audio Output",
  is_window_visible: true
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
let isCeilingHovered = false;
let isMaximizedWindow = false;
let lastRenderTime = performance.now();
let lastTextUpdateTime = 0;
let rafId = null;

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
  if (!state.is_window_visible) {
    rafId = null;
    return;
  }

  if (!now) now = performance.now();
  if (state.eco_mode && (now - lastRenderTime < 32)) {
    rafId = requestAnimationFrame(renderMeter);
    return;
  }

  rafId = requestAnimationFrame(renderMeter);

  const dt = Math.min(0.08, Math.max(0.001, (now - lastRenderTime) / 1000.0));
  lastRenderTime = now;

  const w = canvasCssW;
  const h = canvasCssH;
  if (w <= 10 || h <= 10) return;

  ctx.clearRect(0, 0, w, h);

  const padTop = 16;
  const padBottom = 22;
  const padLeft = 48;
  const padRight = 100;
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

  // 1. Subtle acoustic background grid
  ctx.strokeStyle = "rgba(255, 255, 255, 0.025)";
  ctx.lineWidth = 1;
  const gridStepX = Math.round(availW / 8);
  for (let gx = padLeft; gx <= padLeft + availW; gx += gridStepX) {
    ctx.beginPath();
    ctx.moveTo(gx + 0.5, padTop);
    ctx.lineTo(gx + 0.5, padTop + meterH);
    ctx.stroke();
  }

  // 2. Horizontal decibel ticks on the left with color coding
  const dbTicks = [
    { db: 0, color: "#ff2a5f" },
    { db: -6, color: "#f59e0b" },
    { db: -12, color: "#ff4d79" },
    { db: -18, color: "#64748b" },
    { db: -24, color: "#64748b" },
    { db: -36, color: "#64748b" }
  ];

  ctx.font = "700 10.5px 'JetBrains Mono', monospace";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";

  dbTicks.forEach(tick => {
    const y = Math.round(dbToY(tick.db)) + 0.5;
    ctx.strokeStyle = "rgba(255, 255, 255, 0.04)";
    ctx.beginPath();
    ctx.setLineDash([2, 4]);
    ctx.moveTo(padLeft - 2, y);
    ctx.lineTo(padLeft + availW, y);
    ctx.stroke();

    ctx.fillStyle = tick.color;
    ctx.fillText(`${tick.db} dB`, padLeft - 6, y);
  });
  ctx.setLineDash([]);

  // 3. Central Dual VU Meters (LEFT and RIGHT channels centered)
  const barW = 24;
  const barGap = 32;
  const centerX = padLeft + availW / 2;
  const chX = [centerX - barW - barGap / 2, centerX + barGap / 2];
  const chLabels = ["LEFT", "RIGHT"];
  const numSegments = 18;
  const segH = Math.max(2, Math.floor((meterH - (numSegments - 1) * 2) / numSegments));

  for (let i = 0; i < 2; i++) {
    const bx = Math.round(chX[i]);
    const targetVal = state.channel_peaks[i] || 0.0;

    const alpha = 1.0 - Math.exp(-dt / 0.045);
    smoothPeaks[i] = (smoothPeaks[i] || 0) + (targetVal - (smoothPeaks[i] || 0)) * alpha;
    const dispVal = Math.max(0.0, Math.min(1.5, smoothPeaks[i]));

    if (targetVal >= (peakHolds[i] || 0)) {
      peakHolds[i] = targetVal;
      peakHoldTimes[i] = now;
    } else if (now - (peakHoldTimes[i] || 0) > 1200) {
      const decay = 0.6 * dt;
      peakHolds[i] = Math.max(0.0, peakHolds[i] - decay);
    }

    // Slot border & background
    ctx.fillStyle = "rgba(8, 12, 22, 0.9)";
    ctx.fillRect(bx - 1, padTop, barW + 2, meterH);
    ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
    ctx.strokeRect(bx - 1, padTop, barW + 2, meterH);

    const activeTopY = scalarToY(dispVal);
    const threshY = dbToY(state.threshold_db);

    for (let s = 0; s < numSegments; s++) {
      const sy = padTop + meterH - (s + 1) * (segH + 2);
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

      ctx.fillRect(bx + 1, sy, barW - 2, segH);
    }

    // High-res white peak hold indicator
    if (peakHolds[i] > 0.01) {
      const pkY = Math.round(scalarToY(peakHolds[i])) + 0.5;
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(bx, pkY);
      ctx.lineTo(bx + barW, pkY);
      ctx.stroke();
      ctx.lineWidth = 1;
    }

    // Channel label below slot
    ctx.fillStyle = "#64748b";
    ctx.font = "800 10px 'JetBrains Mono', monospace";
    ctx.textAlign = "center";
    ctx.fillText(chLabels[i], bx + barW / 2, padTop + meterH + 15);
  }

  // 4. Horizontal Limiter Threshold Line across the meter
  const threshY = Math.round(dbToY(state.threshold_db)) + 0.5;
  const isCeilActive = isDraggingCeiling || isCeilingHovered;

  ctx.strokeStyle = isCeilActive ? "#ff4d79" : "#ff2a5f";
  ctx.lineWidth = isCeilActive ? 2 : 1.5;
  ctx.beginPath();
  ctx.moveTo(padLeft - 2, threshY);
  ctx.lineTo(padLeft + availW - 6, threshY);
  ctx.stroke();

  // LIMIT pill badge on the line
  const badgeW = 92;
  const badgeH = 20;
  const badgeX = padLeft + availW - badgeW - 6;
  const badgeY = Math.round(threshY - badgeH / 2);

  ctx.fillStyle = "#ff2a5f";
  ctx.beginPath();
  ctx.roundRect(badgeX, badgeY, badgeW, badgeH, 4);
  ctx.fill();

  ctx.fillStyle = "#ffffff";
  ctx.font = "800 10.5px 'JetBrains Mono', monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(`LIMIT: ${state.threshold_db.toFixed(0)} dB`, badgeX + badgeW / 2, threshY);

  // 5. Gain Reduction (GR) container on the right
  const grX = padLeft + availW + 12;
  const grW = 82;
  const grH = meterH;

  ctx.fillStyle = "rgba(7, 11, 20, 0.95)";
  ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
  ctx.beginPath();
  ctx.roundRect(grX, padTop, grW, grH, 6);
  ctx.fill();
  ctx.stroke();

  const grAlpha = 1.0 - Math.exp(-dt / 0.06);
  smoothGR = smoothGR + (Math.abs(state.gain_reduction_db) - smoothGR) * grAlpha;

  // GR Header readout in crimson
  ctx.fillStyle = "#ff2a5f";
  ctx.font = "800 11px 'JetBrains Mono', monospace";
  ctx.textAlign = "center";
  const grText = smoothGR > 0.1 ? `-${smoothGR.toFixed(1)} dB` : "-0.0 dB";
  ctx.fillText(`GR  ${grText}`, grX + grW / 2, padTop + 14);

  // Stacked horizontal attenuation LED bars (3-tier calibrated thresholds)
  const numGrBars = 3;
  const grBarW = grW - 16;
  const grBarH = 7;
  const grBarGap = 5;
  const grBarsStartY = padTop + 26;
  const barThresholds = [0.3, 3.0, 6.0];

  for (let b = 0; b < numGrBars; b++) {
    const by = grBarsStartY + b * (grBarH + grBarGap);
    const isBarLit = smoothGR >= barThresholds[b];

    if (isBarLit) {
      const barGrad = ctx.createLinearGradient(grX + 8, 0, grX + 8 + grBarW, 0);
      if (b === 0) {
        barGrad.addColorStop(0, "#f59e0b");
        barGrad.addColorStop(1, "#f59e0b");
      } else if (b === 1) {
        barGrad.addColorStop(0, "#f59e0b");
        barGrad.addColorStop(1, "#ff4d79");
      } else {
        barGrad.addColorStop(0, "#ff2a5f");
        barGrad.addColorStop(1, "#ff2a5f");
      }
      ctx.fillStyle = barGrad;
    } else {
      ctx.fillStyle = "rgba(255, 255, 255, 0.05)";
    }

    ctx.beginPath();
    ctx.roundRect(grX + 8, by, grBarW, grBarH, 3);
    ctx.fill();
  }

  // Ticks at bottom of GR box
  ctx.fillStyle = "#64748b";
  ctx.font = "700 8.5px 'JetBrains Mono', monospace";
  ctx.textAlign = "center";
  ctx.fillText("0dB  -6dB  -12dB", grX + grW / 2, padTop + grH - 8);
}

function getCeilingY() {
  const rect = canvas.getBoundingClientRect();
  const minDb = -36.0, maxDb = 0.0, padTop = 16, meterH = rect.height - padTop - 22;
  const clamped = Math.max(minDb, Math.min(maxDb, state.threshold_db));
  return padTop + (1.0 - (clamped - minDb) / (maxDb - minDb)) * meterH;
}

canvas.addEventListener("mousemove", (e) => {
  const rect = canvas.getBoundingClientRect();
  const y = e.clientY - rect.top;

  if (isDraggingCeiling) {
    const padTop = 16;
    const meterH = rect.height - padTop - 22;
    const norm = Math.max(0, Math.min(1, 1.0 - (y - padTop) / meterH));
    const newDb = -36.0 + norm * 36.0;
    updateCeiling(newDb);
    canvas.style.cursor = "grabbing";
    return;
  }

  const threshY = getCeilingY();
  if (Math.abs(y - threshY) < 14) {
    isCeilingHovered = true;
    canvas.style.cursor = "ns-resize";
  } else {
    if (isCeilingHovered) {
      isCeilingHovered = false;
      canvas.style.cursor = "default";
    }
  }
});

canvas.addEventListener("mousedown", (e) => {
  const rect = canvas.getBoundingClientRect();
  const y = e.clientY - rect.top;
  const threshY = getCeilingY();

  if (Math.abs(y - threshY) < 16) {
    isDraggingCeiling = true;
    isCeilingHovered = true;
    canvas.style.cursor = "grabbing";
  }
});

canvas.addEventListener("mouseleave", () => {
  if (!isDraggingCeiling) {
    isCeilingHovered = false;
    canvas.style.cursor = "default";
  }
});

window.addEventListener("mouseup", () => {
  if (isDraggingCeiling) {
    isDraggingCeiling = false;
    canvas.style.cursor = isCeilingHovered ? "ns-resize" : "default";
  }
});

function showToast(message, type = "info") {
  const container = document.getElementById("toastContainer");
  if (!container) return;

  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  let icon = "⚡";
  if (type === "warning") icon = "⚠️";
  if (type === "success") icon = "🛡️";

  toast.innerHTML = `<span style="font-size: 14px;">${icon}</span><span>${message}</span>`;
  container.appendChild(toast);

  requestAnimationFrame(() => {
    toast.classList.add("show");
  });

  setTimeout(() => {
    toast.classList.remove("show");
    setTimeout(() => {
      if (toast.parentNode) toast.parentNode.removeChild(toast);
    }, 300);
  }, 2200);
}

function updateQuickCeilingButtons(db) {
  const btns = [
    { id: "btnCeil_6", val: -6 },
    { id: "btnCeil_12", val: -12 },
    { id: "btnCeil_18", val: -18 },
    { id: "btnCeil_24", val: -24 }
  ];
  btns.forEach(b => {
    const el = document.getElementById(b.id);
    if (el) {
      if (Math.abs(db - b.val) < 0.3) {
        el.classList.add("active");
      } else {
        el.classList.remove("active");
      }
    }
  });
}

function updateSliderTrack(slider, color) {
  if (!slider) return;
  const min = parseFloat(slider.min);
  const max = parseFloat(slider.max);
  const val = parseFloat(slider.value);
  const pct = Math.max(0, Math.min(100, ((val - min) / (max - min)) * 100));
  slider.style.background = `linear-gradient(to right, ${color} 0%, ${color} ${pct}%, #111827 ${pct}%, #111827 100%)`;
}

function updateCeiling(db) {
  state.threshold_db = Math.max(-30.0, Math.min(0.0, db));
  const pct = Math.pow(10, state.threshold_db / 20.0) * 100.0;
  state.threshold_percent = pct;

  const slider = document.getElementById("ceilingSlider");
  if (slider) {
    slider.value = state.threshold_db;
    updateSliderTrack(slider, "#ff2a5f");
  }

  const readout = document.getElementById("ceilingReadout");
  if (readout) {
    readout.innerText = `${state.threshold_db.toFixed(1)} dB`;
  }

  updateQuickCeilingButtons(state.threshold_db);
  updateGuideLiveBadges();

  if (window.pywebview && window.pywebview.api) {
    window.pywebview.api.set_threshold(state.threshold_db);
  }
}

function setCeilingDb(db) {
  updateCeiling(db);
}

function setReleaseMs(ms) {
  const val = parseInt(ms);
  state.release_ms = val;
  const slider = document.getElementById("releaseSlider");
  if (slider) {
    slider.value = val;
    updateSliderTrack(slider, "#00f2fe");
  }
  const readout = document.getElementById("releaseNum");
  if (readout) {
    readout.innerText = `${val} ms`;
  }

  const tags = [
    { id: "btnRel_50", val: 50 },
    { id: "btnRel_120", val: 120 },
    { id: "btnRel_300", val: 300 }
  ];
  tags.forEach(t => {
    const el = document.getElementById(t.id);
    if (el) {
      if (Math.abs(val - t.val) < 15) {
        el.classList.add("active");
      } else {
        el.classList.remove("active");
      }
    }
  });

  if (window.pywebview && window.pywebview.api) {
    window.pywebview.api.set_release_ms(val);
  }
  updateGuideLiveBadges();
  showToast(`Footstep Recovery: ${val} ms`, "info");
}

function setKneeMode(mode) {
  state.knee_mode = mode;
  const softBtn = document.getElementById("kneeSoftBtn");
  const brickBtn = document.getElementById("kneeBrickBtn");
  const ratioBadge = document.getElementById("dynamicsRatioBadge");
  const noteText = document.getElementById("curveNoteText");
  const kneeSwitch = document.getElementById("kneeSwitch");

  if (mode === "soft_knee") {
    if (softBtn) softBtn.classList.add("active");
    if (brickBtn) brickBtn.classList.remove("active");
    if (ratioBadge) ratioBadge.innerText = "4:1 RATIO";
    if (noteText) noteText.innerText = "Soft-Knee Preserving Distance (4:1)";
    if (kneeSwitch) kneeSwitch.checked = true;
  } else {
    if (softBtn) softBtn.classList.remove("active");
    if (brickBtn) brickBtn.classList.add("active");
    if (ratioBadge) ratioBadge.innerText = "∞:1 RATIO";
    if (noteText) noteText.innerText = "Brickwall Limiter (∞:1)";
    if (kneeSwitch) kneeSwitch.checked = false;
  }

  if (window.pywebview && window.pywebview.api) {
    window.pywebview.api.set_knee_mode(mode);
  }
  updateGuideLiveBadges();
  showToast(`Dynamics Mode: ${mode === "soft_knee" ? "Soft-Knee (4:1)" : "Brickwall (∞:1)"}`, "info");
}

function setScope(mode) {
  state.target_mode = mode;
  document.querySelectorAll(".scope-pill-btn").forEach(btn => btn.classList.remove("active"));
  if (mode === "auto_game") {
    const btn = document.getElementById("btnScopeAuto");
    if (btn) btn.classList.add("active");
  }
  if (mode === "specific_app") {
    const btn = document.getElementById("btnScopeApp");
    if (btn) btn.classList.add("active");
    const drawer = document.getElementById("customAppDrawer");
    if (drawer) {
      drawer.style.display = "block";
      refreshAudioProcesses();
    }
  }
  if (mode === "master_device") {
    const btn = document.getElementById("btnScopeMaster");
    if (btn) btn.classList.add("active");
  }

  renderMonitoredChips();
  updateGuideLiveBadges();

  if (window.pywebview && window.pywebview.api) {
    window.pywebview.api.set_scope(mode);
  }
}

function toggleAppDrawer() {
  const drawer = document.getElementById("customAppDrawer");
  if (!drawer) return;
  if (drawer.style.display === "none" || !drawer.style.display) {
    drawer.style.display = "block";
    refreshAudioProcesses();
  } else {
    drawer.style.display = "none";
  }
}

function selectTargetProcess(app) {
  if (!app) return;
  state.target_process = app;

  const input = document.getElementById("customProcessInput");
  if (input) input.value = app;

  const dropdown = document.getElementById("processDropdown");
  if (dropdown) dropdown.value = app;

  if (window.pywebview && window.pywebview.api && window.pywebview.api.set_custom_process) {
    window.pywebview.api.set_custom_process(app);
  }

  renderMonitoredChips();
  showToast(`Target App Selected: ${app}`, "success");
}

function onAutoWatchToggle(enabled) {
  state.auto_watch_mode = enabled;
  if (window.pywebview && window.pywebview.api && window.pywebview.api.set_auto_watch_mode) {
    window.pywebview.api.set_auto_watch_mode(enabled);
  }
  showToast(enabled ? "Auto-Watch Mode: Enabled" : "Auto-Watch Mode: Disabled", "info");
}

function toggleAutoStart(enabled) {
  state.start_with_windows = enabled;
  if (window.pywebview && window.pywebview.api && window.pywebview.api.set_start_with_windows) {
    window.pywebview.api.set_start_with_windows(enabled);
  }
}

function renderMonitoredChips() {
  const container = document.getElementById("monitoredChipsList");
  if (!container) return;
  container.innerHTML = "";

  if (!state.monitored_apps || state.monitored_apps.length === 0) {
    container.innerHTML = '<span style="font-size: 11px; color: #64748b; font-style: italic; padding: 2px;">No active games in list. Click + Add to include games.</span>';
    return;
  }

  state.monitored_apps.forEach(app => {
    const chip = document.createElement("div");
    chip.className = "monitored-chip";

    const cleanApp = app.toLowerCase().replace(".exe", "");
    const cleanTarget = (state.target_process || "").toLowerCase().replace(".exe", "");
    const cleanActive = (state.active_target || "").toLowerCase().replace(".exe", "");

    const isRunningNow = cleanActive && cleanActive.includes(cleanApp);
    const isTarget = state.target_mode === "specific_app" && cleanTarget && cleanApp === cleanTarget;

    if (isRunningNow || isTarget) {
      chip.classList.add("chip-active");
      const dot = document.createElement("span");
      dot.className = "chip-dot";
      chip.appendChild(dot);
    }

    chip.onclick = () => {
      selectTargetProcess(app);
    };

    const nameSpan = document.createElement("span");
    nameSpan.className = "chip-name";
    nameSpan.textContent = app;
    chip.appendChild(nameSpan);

    const removeBtn = document.createElement("span");
    removeBtn.className = "chip-remove";
    removeBtn.innerHTML = "&times;";
    removeBtn.title = `Remove ${app}`;
    removeBtn.onclick = (e) => {
      e.stopPropagation();
      removeMonitoredApp(app);
    };
    chip.appendChild(removeBtn);

    container.appendChild(chip);
  });
}

async function addSelectedProcess() {
  const dropdown = document.getElementById("processDropdown");
  if (!dropdown || !dropdown.value) return;
  const proc = dropdown.value.trim();
  if (!proc) return;

  if (window.pywebview && window.pywebview.api && window.pywebview.api.add_monitored_app) {
    state.monitored_apps = await window.pywebview.api.add_monitored_app(proc);
  } else {
    if (!state.monitored_apps.includes(proc)) state.monitored_apps.push(proc);
  }
  selectTargetProcess(proc);
}

async function addCustomInputProcess() {
  const input = document.getElementById("customProcessInput");
  if (!input || !input.value) return;
  let proc = input.value.trim();
  if (!proc) return;
  if (!proc.toLowerCase().endsWith(".exe")) {
    proc += ".exe";
  }

  if (window.pywebview && window.pywebview.api && window.pywebview.api.add_monitored_app) {
    state.monitored_apps = await window.pywebview.api.add_monitored_app(proc);
  } else {
    if (!state.monitored_apps.includes(proc)) state.monitored_apps.push(proc);
  }
  input.value = "";
  selectTargetProcess(proc);
}

async function removeMonitoredApp(app) {
  if (window.pywebview && window.pywebview.api && window.pywebview.api.remove_monitored_app) {
    state.monitored_apps = await window.pywebview.api.remove_monitored_app(app);
  } else {
    state.monitored_apps = state.monitored_apps.filter(x => x.toLowerCase() !== app.toLowerCase());
  }
  renderMonitoredChips();
  showToast(`Removed ${app} from list`, "info");
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
          const cleanProc = proc.toLowerCase().replace(".exe", "");
          const cleanTarget = (state.target_process || "").toLowerCase().replace(".exe", "");
          if (cleanTarget && cleanProc === cleanTarget) {
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
  selectTargetProcess(procName);
}

async function browseExeFile() {
  if (window.pywebview && window.pywebview.api && window.pywebview.api.browse_for_exe) {
    const exeName = await window.pywebview.api.browse_for_exe();
    if (exeName) {
      selectTargetProcess(exeName);
      await refreshAudioProcesses();
    }
  }
}

function highlightProfileCard(profileName) {
  state.active_profile = profileName;
  const clean = (profileName || "").toLowerCase();
  document.querySelectorAll(".profile-item, .profile-card").forEach(card => {
    const p = (card.getAttribute("data-profile") || "").toLowerCase();
    const name = (card.querySelector(".prof-name, .profile-name")?.textContent || "").toLowerCase();
    if (p === clean || clean.includes(name) || (p && clean.includes(p))) {
      card.classList.add("active");
    } else {
      card.classList.remove("active");
    }
  });
  updateGuideLiveBadges();
}

function applyProfile(profileName) {
  highlightProfileCard(profileName);
  showToast(`Loaded Profile: ${profileName}`, "success");

  if (window.pywebview && window.pywebview.api) {
    window.pywebview.api.apply_profile(profileName);
  }
}

function toggleNewProfileDrawer(forceState) {
  const drawer = document.getElementById("profileDrawer");
  if (!drawer) return;
  const isCurrentlyOpen = drawer.style.display !== "none";
  const shouldOpen = forceState !== undefined ? forceState : !isCurrentlyOpen;
  drawer.style.display = shouldOpen ? "block" : "none";
  if (shouldOpen) {
    const input = document.getElementById("newProfileNameInput");
    if (input) {
      input.value = "";
      input.focus();
    }
  }
}

function saveCustomProfile() {
  const input = document.getElementById("newProfileNameInput");
  if (!input) return;
  const rawName = input.value.trim();
  if (!rawName) {
    showToast("Please enter a profile name", "warning");
    return;
  }
  const cleanName = rawName;

  const grid = document.querySelector(".profiles-grid-4x2");
  if (!grid) return;

  // Check if profile item already exists
  let existingItem = grid.querySelector(`[data-profile="${cleanName}"]`);
  if (!existingItem) {
    const item = document.createElement("div");
    item.className = "profile-item active";
    item.setAttribute("data-profile", cleanName);
    item.onclick = () => {
      applyProfile(cleanName);
    };

    const topRow = document.createElement("div");
    topRow.className = "prof-top-row";
    topRow.innerHTML = `<span class="prof-name">${cleanName}</span><span class="prof-dot">●</span>`;

    const statsRow = document.createElement("div");
    statsRow.className = "prof-stats-row";
    statsRow.innerHTML = `<span class="prof-db">${state.threshold_db.toFixed(0)} dB</span><span class="prof-ms">${state.release_ms}ms</span>`;

    item.appendChild(topRow);
    item.appendChild(statsRow);
    grid.appendChild(item);
  }

  toggleNewProfileDrawer(false);
  highlightProfileCard(cleanName);
  showToast(`Custom profile saved: ${cleanName}`, "success");
}

window.nudgeCeiling = function(delta) {
  const current = state.threshold_db;
  const target = Math.max(-30.0, Math.min(0.0, current + delta));
  updateCeiling(target);
  showToast(`Ceiling: ${target.toFixed(1)} dB`, "info");
};

function emergencyReset() {
  updateCeiling(0.0);
  showToast("Panic Reset: Volume Ceiling set to 100% (0 dB)", "warning");
  if (window.pywebview && window.pywebview.api) {
    window.pywebview.api.emergency_reset();
  }
}

function minimizeWindow() {
  if (window.pywebview && window.pywebview.api) window.pywebview.api.minimize_window();
}

function updateMaximizeIcon(isMax) {
  isMaximizedWindow = isMax;
  const icon = document.getElementById("maxRestoreIcon");
  if (!icon) return;
  if (isMax) {
    icon.innerHTML = '<rect x="2.5" y="1" width="5.5" height="5.5" rx="1" fill="none" stroke="currentColor" stroke-width="1.2"/><rect x="1" y="2.5" width="5.5" height="5.5" rx="1" fill="none" stroke="currentColor" stroke-width="1.2"/>';
  } else {
    icon.innerHTML = '<rect x="1" y="1" width="8" height="8" rx="1"/>';
  }
}

async function toggleMaximize() {
  if (window.pywebview && window.pywebview.api) {
    const isMax = await window.pywebview.api.toggle_maximize();
    updateMaximizeIcon(isMax);
  }
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

function setEcoModeUI(enabled) {
  state.eco_mode = !!enabled;
  const btn = document.getElementById("btnEcoToggle");
  const text = document.getElementById("ecoBtnText");
  if (btn) {
    if (state.eco_mode) {
      btn.classList.add("active");
    } else {
      btn.classList.remove("active");
    }
  }
  if (text) {
    text.innerText = state.eco_mode ? "Eco: On" : "Eco: Off";
  }
}

function toggleEcoMode() {
  const nextVal = !state.eco_mode;
  setEcoModeUI(nextVal);
  updateGuideLiveBadges();
  if (window.pywebview && window.pywebview.api && window.pywebview.api.toggle_eco_mode) {
    window.pywebview.api.toggle_eco_mode(nextVal);
  }
  showToast(nextVal ? "Eco Mode: Active (Low CPU, 30 FPS)" : "Eco Mode: Off (Pro Audio, Max FPS)", "info");
}

// ==========================================
// Settings Guide Modal & Clean Formatting
// ==========================================

function formatCleanDeviceName(rawName) {
  if (!rawName) return "Audio Output";
  let clean = String(rawName).trim();
  // Strip trademark symbols
  clean = clean.replace(/\([Rr]\)|\([Tt][Mm]\)|®|™/g, "").trim();

  // Strip prefix wrappers like "Speakers (xyz)" or "Headphones (xyz)" or "Speakers / Headphones (xyz)"
  const parenMatch = clean.match(/^(?:Speakers|Headphones|Headset|Speakers\s*\/\s*Headphones|Line Out|Digital Output)\s*\((.+)\)$/i);
  if (parenMatch && parenMatch[1]) {
    clean = parenMatch[1].trim();
  }

  // Remove duplicate spaces
  clean = clean.replace(/\s{2,}/g, " ").trim();

  // If excessively long, trim neatly
  if (clean.length > 24) {
    clean = clean.substring(0, 22) + "…";
  }
  return clean || "Audio Output";
}

// ==========================================
// Interactive Audio Output Device Quick-Switcher
// ==========================================

let isDeviceMenuOpen = false;

function getDeviceIcon(rawName) {
  const n = (rawName || "").toLowerCase();
  if (n.includes("headphone") || n.includes("headset") || n.includes("iem") || n.includes("earphone") || n.includes("hyperx") || n.includes("arctis") || n.includes("cloud")) {
    return "🎧";
  }
  if (n.includes("xg27") || n.includes("vg32") || n.includes("nvidia") || n.includes("monitor") || n.includes("display") || n.includes("hdmi") || n.includes("tv") || n.includes("asus") || n.includes("benq") || n.includes("lg")) {
    return "🖥️";
  }
  return "🔊";
}

async function toggleDeviceMenu(event) {
  if (event) event.stopPropagation();
  if (isDeviceMenuOpen) {
    closeDeviceMenu();
  } else {
    await openDeviceMenu();
  }
}

async function openDeviceMenu() {
  const popover = document.getElementById("deviceMenuPopover");
  const tag = document.getElementById("statusDeviceTag");
  if (!popover || !tag) return;

  isDeviceMenuOpen = true;
  tag.classList.add("open");
  popover.style.display = "block";

  const listEl = document.getElementById("deviceMenuList");
  if (listEl) {
    listEl.innerHTML = `<div style="padding: 12px; font-size: 11px; color: var(--text-muted); text-align: center;">Scanning playback devices...</div>`;
  }

  if (window.pywebview && window.pywebview.api && window.pywebview.api.get_audio_devices) {
    try {
      const devices = await window.pywebview.api.get_audio_devices();
      renderDeviceMenu(devices || []);
    } catch (err) {
      if (listEl) {
        listEl.innerHTML = `<div style="padding: 12px; font-size: 11px; color: var(--accent-crimson); text-align: center;">Failed to query devices</div>`;
      }
    }
  } else {
    renderDeviceMenu([
      { id: "1", name: state.device_name || "Realtek Audio", is_default: true }
    ]);
  }
}

function closeDeviceMenu() {
  isDeviceMenuOpen = false;
  const popover = document.getElementById("deviceMenuPopover");
  const tag = document.getElementById("statusDeviceTag");
  if (popover) popover.style.display = "none";
  if (tag) tag.classList.remove("open");
}

function renderDeviceMenu(devices) {
  const listEl = document.getElementById("deviceMenuList");
  const countEl = document.getElementById("deviceMenuCount");
  if (!listEl) return;

  listEl.innerHTML = "";
  if (countEl) countEl.innerText = `${devices.length} ${devices.length === 1 ? 'Device' : 'Devices'}`;

  if (!devices || devices.length === 0) {
    listEl.innerHTML = `<div style="padding: 12px; font-size: 11px; color: var(--text-muted); text-align: center;">No active audio endpoints detected</div>`;
    return;
  }

  devices.forEach(dev => {
    const item = document.createElement("div");
    item.className = `device-menu-item ${dev.is_default ? 'active' : ''}`;
    
    const icon = getDeviceIcon(dev.name);
    const cleanName = formatCleanDeviceName(dev.name);

    item.innerHTML = `
      <div class="device-item-left">
        <span class="device-item-icon">${icon}</span>
        <div class="device-item-name-group">
          <span class="device-item-name">${cleanName}</span>
          <span class="device-item-raw" title="${dev.name}">${dev.name}</span>
        </div>
      </div>
      ${dev.is_default ? '<span class="device-item-active-badge">ACTIVE</span>' : ''}
    `;

    item.addEventListener("click", () => {
      selectAudioDevice(dev.id, cleanName, icon);
    });

    listEl.appendChild(item);
  });
}

async function selectAudioDevice(deviceId, cleanName, icon) {
  closeDeviceMenu();
  showToast(`Switching audio output to ${cleanName}...`, "info");

  const devIconEl = document.getElementById("deviceIcon");
  if (devIconEl && icon) devIconEl.innerText = icon;

  const devTextEl = document.getElementById("deviceText");
  if (devTextEl) devTextEl.innerText = cleanName;

  if (window.pywebview && window.pywebview.api && window.pywebview.api.set_default_device) {
    try {
      const ok = await window.pywebview.api.set_default_device(deviceId);
      if (ok) {
        showToast(`Active Output: ${cleanName}`, "success");
      } else {
        showToast(`Failed to switch to ${cleanName}`, "warning");
      }
    } catch (e) {
      showToast(`Error switching device: ${e}`, "warning");
    }
  }
}

function openSettingsGuide(targetId) {
  const modal = document.getElementById("settingsGuideModal");
  if (!modal) return;
  modal.style.display = "flex";
  updateGuideLiveBadges();

  // Reset tab filter to 'all' so target card is visible
  filterGuide("all");

  const searchInput = document.getElementById("guideSearchInput");
  if (searchInput) searchInput.value = "";

  if (targetId) {
    let cardId = targetId;
    if (!cardId.startsWith("guide-")) {
      cardId = "guide-" + cardId;
    }
    setTimeout(() => {
      const el = document.getElementById(cardId);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        el.classList.remove("guide-card-highlight");
        void el.offsetWidth; // Trigger reflow for animation restart
        el.classList.add("guide-card-highlight");
        setTimeout(() => el.classList.remove("guide-card-highlight"), 2400);
      }
    }, 80);
  } else {
    const container = document.getElementById("guideCardsContainer");
    if (container) container.scrollTop = 0;
  }
}

function closeSettingsGuide() {
  const modal = document.getElementById("settingsGuideModal");
  if (modal) modal.style.display = "none";
}

function onGuideBackdropClick(event) {
  if (event.target && event.target.id === "settingsGuideModal") {
    closeSettingsGuide();
  }
}

function filterGuide(category) {
  const tabs = document.querySelectorAll(".guide-tab");
  tabs.forEach(t => {
    t.classList.toggle("active", t.getAttribute("data-tab") === category);
  });

  const cards = document.querySelectorAll(".guide-card");
  cards.forEach(card => {
    const cardCat = card.getAttribute("data-category");
    if (category === "all" || cardCat === category) {
      card.style.display = "block";
    } else {
      card.style.display = "none";
    }
  });
}

function searchGuide(query) {
  const q = (query || "").toLowerCase().trim();
  const tabs = document.querySelectorAll(".guide-tab");

  if (q.length > 0) {
    tabs.forEach(t => t.classList.toggle("active", t.getAttribute("data-tab") === "all"));
  }

  const cards = document.querySelectorAll(".guide-card");
  cards.forEach(card => {
    if (!q) {
      const activeTab = document.querySelector(".guide-tab.active");
      const currentCat = activeTab ? activeTab.getAttribute("data-tab") : "all";
      const cardCat = card.getAttribute("data-category");
      card.style.display = (currentCat === "all" || cardCat === currentCat) ? "block" : "none";
      return;
    }
    const text = card.textContent.toLowerCase();
    card.style.display = text.includes(q) ? "block" : "none";
  });
}

function updateGuideLiveBadges() {
  const pLimiter = document.getElementById("guideBadge_limiter");
  if (pLimiter) {
    pLimiter.innerText = state.enabled ? "LIVE: ONLINE" : "LIVE: OFF";
    pLimiter.style.borderColor = state.enabled ? "var(--accent-emerald)" : "var(--accent-crimson)";
    pLimiter.style.color = state.enabled ? "var(--accent-emerald)" : "var(--accent-crimson)";
  }

  const pCeiling = document.getElementById("guideBadge_ceiling");
  if (pCeiling) {
    pCeiling.innerText = `LIVE: ${state.threshold_db.toFixed(1)} dB`;
  }

  const pKnee = document.getElementById("guideBadge_knee");
  if (pKnee) {
    pKnee.innerText = state.knee_mode === "soft_knee" ? "LIVE: Soft-Knee (4:1)" : "LIVE: Brickwall (∞:1)";
  }

  const pRelease = document.getElementById("guideBadge_release");
  if (pRelease) {
    pRelease.innerText = `LIVE: ${state.release_ms} ms`;
  }

  const pScope = document.getElementById("guideBadge_scope");
  if (pScope) {
    let scopeName = "Auto-Detect Game";
    if (state.target_mode === "specific_app") scopeName = `Specific App (${state.target_process || "Selected"})`;
    else if (state.target_mode === "master_device" || state.target_mode === "master") scopeName = "Master PC (Global)";
    pScope.innerText = `LIVE: ${scopeName}`;
  }

  const pAutoWatch = document.getElementById("guideBadge_autowatch");
  if (pAutoWatch) {
    pAutoWatch.innerText = state.auto_watch_mode ? "LIVE: Active" : "LIVE: Off";
  }

  const pProfile = document.getElementById("guideBadge_profile");
  if (pProfile) {
    pProfile.innerText = `LIVE: ${state.active_profile || "Custom"}`;
  }

  const pEco = document.getElementById("guideBadge_eco");
  if (pEco) {
    pEco.innerText = state.eco_mode ? "LIVE: Eco Active" : "LIVE: Off";
    pEco.style.borderColor = state.eco_mode ? "var(--accent-amber)" : "var(--border-subtle)";
    pEco.style.color = state.eco_mode ? "var(--accent-amber)" : "var(--text-muted)";
  }
}

window.openSettingsGuide = openSettingsGuide;
window.closeSettingsGuide = closeSettingsGuide;
window.onGuideBackdropClick = onGuideBackdropClick;
window.filterGuide = filterGuide;
window.searchGuide = searchGuide;
window.updateGuideLiveBadges = updateGuideLiveBadges;
window.formatCleanDeviceName = formatCleanDeviceName;
window.toggleDeviceMenu = toggleDeviceMenu;
window.openDeviceMenu = openDeviceMenu;
window.closeDeviceMenu = closeDeviceMenu;
window.selectAudioDevice = selectAudioDevice;
window.getDeviceIcon = getDeviceIcon;

window.onWindowHidden = function() {
  state.is_window_visible = false;
  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
};

window.onWindowShown = function() {
  state.is_window_visible = true;
  updateCanvasDimensions();
  if (!rafId) {
    lastRenderTime = performance.now();
    rafId = requestAnimationFrame(renderMeter);
  }
};

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    window.onWindowHidden();
  } else {
    window.onWindowShown();
  }
});

window.receiveTelemetry = function(data) {
  state.peak = data.peak || 0.0;
  state.output_peak = data.output_peak ?? (data.peak || 0.0);
  state.channel_peaks = data.channel_peaks || [state.peak, state.peak];
  state.gain_reduction_db = data.gain_reduction_db || 0.0;
  state.is_app_running = data.is_app_running ?? true;
  state.auto_watch_status = data.auto_watch_status || "";

  if (data.device_name && data.device_name !== state.device_name) {
    state.device_name = data.device_name;
    const devText = document.getElementById("deviceText");
    if (devText) devText.innerText = formatCleanDeviceName(data.device_name);
    const devIcon = document.getElementById("deviceIcon");
    if (devIcon) devIcon.innerText = getDeviceIcon(data.device_name);
  }

  if (data.eco_mode !== undefined && data.eco_mode !== state.eco_mode) {
    setEcoModeUI(data.eco_mode);
    updateGuideLiveBadges();
  }

  // Real-time sub-millisecond polling latency readout in titlebar
  const latencyText = document.getElementById("statusLatencyText") || document.querySelector(".latency-text");
  if (latencyText && data.poll_latency_ms !== undefined) {
    const modeLabel = data.mmcss_active ? "Pro Audio" : "Active";
    latencyText.innerText = `${modeLabel} · ${data.poll_latency_ms.toFixed(2)}ms`;
  }

  if (state.active_target !== data.active_target || state.is_game_isolated !== data.is_game_isolated) {
    state.active_target = data.active_target || "Master Audio";
    state.is_game_isolated = data.is_game_isolated || false;
    renderMonitoredChips();
  }

  const now = performance.now();
  if (now - lastTextUpdateTime > 50) {
    lastTextUpdateTime = now;

    const isSilent = state.peak <= 0.0001;
    const pkDb = isSilent ? -80.0 : 20.0 * Math.log10(state.peak);
    const grVal = Math.abs(state.gain_reduction_db);

    const pkReadout = document.getElementById("peakReadout");
    if (pkReadout) {
      pkReadout.innerText = isSilent ? "-∞ dB" : `${pkDb.toFixed(1)} dB`;
    }

    const grReadout = document.getElementById("grReadout");
    if (grReadout) {
      grReadout.innerText = grVal > 0.1 ? `-${grVal.toFixed(1)} dB` : "-0.0 dB";
    }

    const outReadout = document.getElementById("outReadout");
    if (outReadout) {
      if (isSilent) {
        outReadout.innerText = "-∞ dB (CLEAN)";
        outReadout.style.color = "var(--text-muted)";
        outReadout.style.textShadow = "none";
      } else if (grVal > 0.1) {
        const clampedDb = Math.min(state.threshold_db, pkDb);
        outReadout.innerText = `${clampedDb.toFixed(1)} dB (CLAMPED)`;
        outReadout.style.color = "var(--accent-cyan)";
        outReadout.style.textShadow = "0 0 6px var(--accent-cyan-glow)";
      } else {
        outReadout.innerText = `${pkDb.toFixed(1)} dB (CLEAN)`;
        outReadout.style.color = "var(--accent-emerald)";
        outReadout.style.textShadow = "0 0 6px var(--accent-emerald-glow)";
      }
    }

    const guideModal = document.getElementById("settingsGuideModal");
    if (guideModal && guideModal.style.display === "flex") {
      updateGuideLiveBadges();
    }
  }
};

window.receiveInitialConfig = function(cfg) {
  state.enabled = cfg.enabled ?? true;
  state.auto_watch_mode = cfg.auto_watch_mode ?? true;
  state.monitored_apps = cfg.monitored_apps || [];
  state.start_with_windows = cfg.start_with_windows ?? false;
  state.threshold_db = cfg.threshold_db ?? -12.0;
  state.threshold_percent = cfg.threshold_percent ?? 50.0;
  state.knee_mode = cfg.knee_mode ?? "soft_knee";
  state.release_ms = cfg.release_ms ?? 120;
  state.target_mode = cfg.target_mode ?? "auto_game";

  if (cfg.device_name) {
    state.device_name = cfg.device_name;
    const devText = document.getElementById("deviceText");
    if (devText) devText.innerText = formatCleanDeviceName(cfg.device_name);
    const devIcon = document.getElementById("deviceIcon");
    if (devIcon) devIcon.innerText = getDeviceIcon(cfg.device_name);
  }

  const pSwitch = document.getElementById("powerSwitch");
  if (pSwitch) pSwitch.checked = state.enabled;
  const pBadge = document.getElementById("powerStatusBadge");
  if (pBadge) {
    pBadge.innerText = state.enabled ? "ONLINE" : "OFF";
    pBadge.style.color = state.enabled ? "var(--accent-emerald)" : "var(--accent-crimson)";
    pBadge.style.borderColor = state.enabled ? "rgba(16, 185, 129, 0.4)" : "rgba(255, 42, 95, 0.4)";
    pBadge.style.background = state.enabled ? "rgba(16, 185, 129, 0.12)" : "rgba(255, 42, 95, 0.12)";
  }

  const autoSwitch = document.getElementById("autoWatchSwitch");
  if (autoSwitch) autoSwitch.checked = state.auto_watch_mode;

  const startSwitch = document.getElementById("autoStartSwitch");
  if (startSwitch) startSwitch.checked = state.start_with_windows;

  if (cfg.eco_mode !== undefined) {
    setEcoModeUI(cfg.eco_mode);
  }

  const cSlider = document.getElementById("ceilingSlider");
  if (cSlider) {
    cSlider.value = state.threshold_db;
    updateSliderTrack(cSlider, "#ff2a5f");
  }
  const cReadout = document.getElementById("ceilingReadout");
  if (cReadout) {
    cReadout.innerText = `${state.threshold_db.toFixed(1)} dB`;
  }

  setKneeMode(state.knee_mode);

  const rSlider = document.getElementById("releaseSlider");
  if (rSlider) {
    rSlider.value = state.release_ms;
    updateSliderTrack(rSlider, "#00f2fe");
  }
  const rReadout = document.getElementById("releaseNum");
  if (rReadout) {
    rReadout.innerText = `${state.release_ms} ms`;
  }

  state.target_process = cfg.target_process || "";
  const pInput = document.getElementById("customProcessInput");
  if (pInput) pInput.value = state.target_process;

  state.active_profile = cfg.selected_profile || "PUBG: BATTLEGROUNDS";
  highlightProfileCard(state.active_profile);
  updateQuickCeilingButtons(state.threshold_db);

  renderMonitoredChips();
  setScope(state.target_mode);
  updateGuideLiveBadges();
};

function initWindowDrag() {
  const titlebar = document.querySelector(".titlebar");
  if (!titlebar) return;

  let isDragging = false;
  let startX = 0;
  let startY = 0;

  titlebar.addEventListener("dblclick", (e) => {
    if (e.target.closest(".titlebar-right") || e.target.closest("button") || e.target.closest("input")) {
      return;
    }
    toggleMaximize();
  });

  titlebar.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    if (e.target.closest(".titlebar-right") || e.target.closest("button") || e.target.closest("input")) {
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
  updateQuickCeilingButtons(state.threshold_db);

  const cSlider = document.getElementById("ceilingSlider");
  if (cSlider) {
    cSlider.addEventListener("input", (e) => {
      updateCeiling(parseFloat(e.target.value));
    });
  }

  const rSlider = document.getElementById("releaseSlider");
  if (rSlider) {
    rSlider.addEventListener("input", (e) => {
      setReleaseMs(parseInt(e.target.value));
    });
  }

  const pSwitch = document.getElementById("powerSwitch");
  if (pSwitch) {
    pSwitch.addEventListener("change", (e) => {
      const enabled = e.target.checked;
      state.enabled = enabled;
      const pBadge = document.getElementById("powerStatusBadge");
      if (pBadge) {
        pBadge.innerText = enabled ? "ONLINE" : "OFF";
        pBadge.style.color = enabled ? "var(--accent-emerald)" : "var(--accent-crimson)";
        pBadge.style.borderColor = enabled ? "rgba(16, 185, 129, 0.4)" : "rgba(255, 42, 95, 0.4)";
        pBadge.style.background = enabled ? "rgba(16, 185, 129, 0.12)" : "rgba(255, 42, 95, 0.12)";
      }
      updateGuideLiveBadges();
      if (window.pywebview && window.pywebview.api) {
        window.pywebview.api.toggle_enabled(enabled);
      }
    });
  }

  const dropdown = document.getElementById("processDropdown");
  if (dropdown) {
    dropdown.addEventListener("change", (e) => {
      onProcessDropdownSelect(e.target.value);
    });
  }

  const customInput = document.getElementById("customProcessInput");
  if (customInput) {
    customInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        addCustomInputProcess();
      }
    });
  }

  // Keyboard shortcut routing
  window.addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT" && e.target.type === "text") return;

    if (e.ctrlKey && e.altKey && (e.key === "l" || e.key === "L")) {
      e.preventDefault();
      const pSwitch = document.getElementById("powerSwitch");
      if (pSwitch) {
        pSwitch.checked = !pSwitch.checked;
        pSwitch.dispatchEvent(new Event("change"));
      }
    }

    if (e.ctrlKey && e.altKey && (e.key === "r" || e.key === "R")) {
      e.preventDefault();
      emergencyReset();
    }

    if (e.ctrlKey && e.altKey && (e.key === "ArrowUp" || e.key === "Up")) {
      e.preventDefault();
      window.nudgeCeiling(1.0);
    }

    if (e.ctrlKey && e.altKey && (e.key === "ArrowDown" || e.key === "Down")) {
      e.preventDefault();
      window.nudgeCeiling(-1.0);
    }

    if (e.key === "Escape") {
      if (isDeviceMenuOpen) {
        closeDeviceMenu();
        return;
      }
      const guideModal = document.getElementById("settingsGuideModal");
      if (guideModal && guideModal.style.display !== "none") {
        closeSettingsGuide();
        return;
      }
      const drawer = document.getElementById("customAppDrawer");
      if (drawer && drawer.style.display !== "none") {
        drawer.style.display = "none";
      }
      const profDrawer = document.getElementById("profileDrawer");
      if (profDrawer && profDrawer.style.display !== "none") {
        profDrawer.style.display = "none";
      }
    }
  });

  document.addEventListener("click", (e) => {
    if (isDeviceMenuOpen) {
      const popover = document.getElementById("deviceMenuPopover");
      const tag = document.getElementById("statusDeviceTag");
      if (popover && !popover.contains(e.target) && tag && !tag.contains(e.target)) {
        closeDeviceMenu();
      }
    }
  });
});
