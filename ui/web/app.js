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
  is_window_visible: true,
  mini_mode: false,
  audio_test_active: false,
  hearing_safe: false,
  combat_guard_db: 0,
  combat_guard_active: false,
  footstep_boost_db: 0,
  boost_applied_db: 0
};

const canvas = document.getElementById("meterCanvas");
const ctx = canvas.getContext("2d", { alpha: true });

// ==========================================
// Visualizer: cached static layer, Bezier history trace, idle gating
// ==========================================
// The renderer only runs while something on screen is moving. Once peaks, holds, GR and the
// history trace have all settled at silence, the rAF loop stops entirely and the canvas
// keeps its last frame, so an idle window costs no GPU time. Telemetry, ceiling changes,
// hover and resizes wake it through requestRender().

const METER_MIN_DB = -36.0;
const METER_MAX_DB = 0.0;
const METER_PAD = { top: 16, bottom: 22, left: 48, right: 100 };
const HISTORY_LEN = 96;            // 96 x 50 ms = 4.8 s of scrolling history
const HISTORY_STEP_MS = 50;
const HISTORY_FLOOR = 0.0158;      // -36 dBFS, anything below sits on the floor
const NUM_SEGMENTS = 18;
const DB_TICKS = [
  { db: 0, color: "#ff2a5f" },
  { db: -6, color: "#f59e0b" },
  { db: -12, color: "#ff4d79" },
  { db: -18, color: "#64748b" },
  { db: -24, color: "#64748b" },
  { db: -36, color: "#64748b" }
];
const GR_BAR_THRESHOLDS = [0.3, 3.0, 6.0];

let canvasCssW = 0;
let canvasCssH = 0;
let canvasDpr = 1;
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

const histIn = new Float32Array(HISTORY_LEN);
const histOut = new Float32Array(HISTORY_LEN);
let histHead = 0;                  // index of the oldest sample
let histNonZero = 0;               // samples above the floor; >0 means the trace is still scrolling
let lastHistTime = 0;

let layout = null;
let staticLayer = null;

function computeLayout(w, h) {
  const meterH = Math.max(10, h - METER_PAD.top - METER_PAD.bottom);
  const availW = Math.max(10, w - METER_PAD.left - METER_PAD.right);
  const barW = 24;
  const barGap = 32;
  const centerX = METER_PAD.left + availW / 2;
  const grX = METER_PAD.left + availW + 12;
  const grW = 82;
  const grBarW = grW - 16;
  const l = {
    w, h, meterH, availW, barW,
    chX: [Math.round(centerX - barW - barGap / 2), Math.round(centerX + barGap / 2)],
    segH: Math.max(2, Math.floor((meterH - (NUM_SEGMENTS - 1) * 2) / NUM_SEGMENTS)),
    grX, grW, grBarW,
    grBarsStartY: METER_PAD.top + 26,
    grGradients: []
  };
  // Gradients are built once per resize rather than on every frame
  const g0 = ctx.createLinearGradient(grX + 8, 0, grX + 8 + grBarW, 0);
  g0.addColorStop(0, "#f59e0b"); g0.addColorStop(1, "#f59e0b");
  const g1 = ctx.createLinearGradient(grX + 8, 0, grX + 8 + grBarW, 0);
  g1.addColorStop(0, "#f59e0b"); g1.addColorStop(1, "#ff4d79");
  const g2 = ctx.createLinearGradient(grX + 8, 0, grX + 8 + grBarW, 0);
  g2.addColorStop(0, "#ff2a5f"); g2.addColorStop(1, "#ff2a5f");
  l.grGradients = [g0, g1, g2];
  return l;
}

function dbToY(db) {
  const clamped = Math.max(METER_MIN_DB, Math.min(METER_MAX_DB, db));
  const norm = (clamped - METER_MIN_DB) / (METER_MAX_DB - METER_MIN_DB);
  return METER_PAD.top + (1.0 - norm) * layout.meterH;
}

function scalarToY(scalar) {
  if (scalar <= 0.0001) return METER_PAD.top + layout.meterH;
  return dbToY(20.0 * Math.log10(scalar));
}

// Everything that only changes on resize lives on an offscreen layer and is blitted per frame
function buildStaticLayer() {
  const l = layout;
  if (!staticLayer) staticLayer = document.createElement("canvas");
  staticLayer.width = canvas.width;
  staticLayer.height = canvas.height;
  const s = staticLayer.getContext("2d");
  s.setTransform(canvasDpr, 0, 0, canvasDpr, 0, 0);
  s.clearRect(0, 0, l.w, l.h);

  s.strokeStyle = "rgba(255, 255, 255, 0.025)";
  s.lineWidth = 1;
  const gridStepX = Math.max(8, Math.round(l.availW / 8));
  for (let gx = METER_PAD.left; gx <= METER_PAD.left + l.availW; gx += gridStepX) {
    s.beginPath();
    s.moveTo(gx + 0.5, METER_PAD.top);
    s.lineTo(gx + 0.5, METER_PAD.top + l.meterH);
    s.stroke();
  }

  s.font = "700 10.5px 'JetBrains Mono', monospace";
  s.textAlign = "right";
  s.textBaseline = "middle";
  s.setLineDash([2, 4]);
  for (const tick of DB_TICKS) {
    const y = Math.round(dbToY(tick.db)) + 0.5;
    s.strokeStyle = "rgba(255, 255, 255, 0.04)";
    s.beginPath();
    s.moveTo(METER_PAD.left - 2, y);
    s.lineTo(METER_PAD.left + l.availW, y);
    s.stroke();
    s.fillStyle = tick.color;
    s.fillText(`${tick.db} dB`, METER_PAD.left - 6, y);
  }
  s.setLineDash([]);

  const chLabels = ["LEFT", "RIGHT"];
  for (let i = 0; i < 2; i++) {
    const bx = l.chX[i];
    s.fillStyle = "rgba(8, 12, 22, 0.9)";
    s.fillRect(bx - 1, METER_PAD.top, l.barW + 2, l.meterH);
    s.strokeStyle = "rgba(255, 255, 255, 0.08)";
    s.strokeRect(bx - 1, METER_PAD.top, l.barW + 2, l.meterH);
    s.fillStyle = "rgba(255, 255, 255, 0.035)";
    for (let seg = 0; seg < NUM_SEGMENTS; seg++) {
      const sy = METER_PAD.top + l.meterH - (seg + 1) * (l.segH + 2);
      s.fillRect(bx + 1, sy, l.barW - 2, l.segH);
    }
    s.fillStyle = "#64748b";
    s.font = "800 10px 'JetBrains Mono', monospace";
    s.textAlign = "center";
    s.fillText(chLabels[i], bx + l.barW / 2, METER_PAD.top + l.meterH + 15);
  }

  s.fillStyle = "rgba(7, 11, 20, 0.95)";
  s.strokeStyle = "rgba(255, 255, 255, 0.08)";
  s.beginPath();
  s.roundRect(l.grX, METER_PAD.top, l.grW, l.meterH, 6);
  s.fill();
  s.stroke();

  s.fillStyle = "rgba(255, 255, 255, 0.05)";
  for (let b = 0; b < GR_BAR_THRESHOLDS.length; b++) {
    s.beginPath();
    s.roundRect(l.grX + 8, l.grBarsStartY + b * 12, l.grBarW, 7, 3);
    s.fill();
  }

  s.fillStyle = "#64748b";
  s.font = "700 8.5px 'JetBrains Mono', monospace";
  s.textAlign = "center";
  s.fillText("0dB  -6dB  -12dB", l.grX + l.grW / 2, METER_PAD.top + l.meterH - 8);
}

function updateCanvasDimensions() {
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;

  canvasCssW = rect.width;
  canvasCssH = rect.height;
  canvasDpr = dpr;

  const targetW = Math.round(rect.width * dpr);
  const targetH = Math.round(rect.height * dpr);
  if (canvas.width !== targetW || canvas.height !== targetH) {
    canvas.width = targetW;
    canvas.height = targetH;
  }

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";

  if (canvasCssW > 10 && canvasCssH > 10) {
    layout = computeLayout(canvasCssW, canvasCssH);
    buildStaticLayer();
  }
  requestRender();
}

const resizeObserver = new ResizeObserver(() => updateCanvasDimensions());
resizeObserver.observe(canvas);
window.addEventListener("resize", updateCanvasDimensions);

function requestRender() {
  if (rafId === null && state.is_window_visible && !state.mini_mode) {
    rafId = requestAnimationFrame(renderMeter);
  }
}

// Called for every telemetry packet. Pushes one history step per 50 ms elapsed so the trace
// scrolls at a constant speed even when idle telemetry slows to 5 Hz.
function pushHistory(inPeak, outPeak, now) {
  if (!lastHistTime) lastHistTime = now;
  let steps = Math.round((now - lastHistTime) / HISTORY_STEP_MS);
  if (steps <= 0) {
    // Same step: keep the louder sample so short transients survive
    const last = (histHead + HISTORY_LEN - 1) % HISTORY_LEN;
    const wasLit = histIn[last] > HISTORY_FLOOR;
    if (inPeak > histIn[last]) histIn[last] = inPeak;
    if (outPeak > histOut[last]) histOut[last] = outPeak;
    if (!wasLit && histIn[last] > HISTORY_FLOOR) histNonZero++;
    return;
  }
  if (steps > HISTORY_LEN) steps = HISTORY_LEN;
  lastHistTime += steps * HISTORY_STEP_MS;
  if (now - lastHistTime > HISTORY_STEP_MS) lastHistTime = now;
  for (let k = 0; k < steps; k++) {
    const isLast = k === steps - 1;
    if (histIn[histHead] > HISTORY_FLOOR) histNonZero--;
    histIn[histHead] = isLast ? inPeak : 0;
    histOut[histHead] = isLast ? outPeak : 0;
    if (histIn[histHead] > HISTORY_FLOOR) histNonZero++;
    histHead = (histHead + 1) % HISTORY_LEN;
  }
}

// Smooth trace through the history ring using quadratic Bezier segments between midpoints
function traceHistory(buf, x0, stepX, offset) {
  let prevX = x0 - offset;
  let prevY = scalarToY(buf[histHead]);
  ctx.lineTo(prevX, prevY);
  for (let k = 1; k < HISTORY_LEN; k++) {
    const x = x0 + k * stepX - offset;
    const y = scalarToY(buf[(histHead + k) % HISTORY_LEN]);
    ctx.quadraticCurveTo(prevX, prevY, (prevX + x) / 2, (prevY + y) / 2);
    prevX = x;
    prevY = y;
  }
  ctx.lineTo(prevX, prevY);
  return prevX;
}

function renderMeter(now) {
  rafId = null;
  if (!state.is_window_visible || state.mini_mode) return;
  if (!now) now = performance.now();

  if (state.eco_mode && (now - lastRenderTime < 32)) {
    rafId = requestAnimationFrame(renderMeter);
    return;
  }

  const dt = Math.min(0.08, Math.max(0.001, (now - lastRenderTime) / 1000.0));
  lastRenderTime = now;

  if (!layout || !staticLayer || canvasCssW <= 10 || canvasCssH <= 10) return;
  const l = layout;
  const top = METER_PAD.top;
  const bottom = top + l.meterH;

  ctx.clearRect(0, 0, l.w, l.h);
  ctx.drawImage(staticLayer, 0, 0, l.w, l.h);

  const threshYExact = dbToY(state.threshold_db);
  const ambY = dbToY(-12);

  // 1. Scrolling input/output history behind the meters
  if (histNonZero > 0) {
    const x0 = METER_PAD.left;
    const stepX = l.availW / (HISTORY_LEN - 1);
    const frac = Math.min(1, Math.max(0, (performance.now() - lastHistTime) / HISTORY_STEP_MS));
    const offset = frac * stepX;

    ctx.save();
    ctx.beginPath();
    ctx.rect(METER_PAD.left, top, l.availW, l.meterH);
    ctx.clip();

    ctx.beginPath();
    ctx.moveTo(x0 - offset, bottom);
    const endX = traceHistory(histIn, x0, stepX, offset);
    ctx.lineTo(endX, bottom);
    ctx.closePath();
    ctx.fillStyle = "rgba(255, 42, 95, 0.10)";
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(x0 - offset, scalarToY(histOut[histHead]));
    traceHistory(histOut, x0, stepX, offset);
    ctx.strokeStyle = "rgba(0, 242, 254, 0.55)";
    ctx.lineWidth = 1.5;
    ctx.lineJoin = "round";
    ctx.stroke();
    ctx.restore();
  }

  // 2. Dual channel segment meters
  let settling = false;
  const peakAlpha = 1.0 - Math.exp(-dt / 0.045);
  for (let i = 0; i < 2; i++) {
    const bx = l.chX[i];
    const targetVal = state.channel_peaks[i] || 0.0;

    smoothPeaks[i] += (targetVal - smoothPeaks[i]) * peakAlpha;
    if (Math.abs(targetVal - smoothPeaks[i]) > 0.0005) settling = true;
    else smoothPeaks[i] = targetVal;
    const dispVal = Math.max(0.0, Math.min(1.5, smoothPeaks[i]));

    if (targetVal >= peakHolds[i]) {
      peakHolds[i] = targetVal;
      peakHoldTimes[i] = now;
    } else if (now - peakHoldTimes[i] > 1200) {
      peakHolds[i] = Math.max(0.0, peakHolds[i] - 0.6 * dt);
    }
    if (peakHolds[i] > 0.0) settling = true;

    const activeTopY = scalarToY(dispVal);
    for (let seg = 0; seg < NUM_SEGMENTS; seg++) {
      const sy = bottom - (seg + 1) * (l.segH + 2);
      if (sy < activeTopY) break;
      ctx.fillStyle = sy < threshYExact ? "#ff2a5f" : (sy < ambY ? "#f59e0b" : "#10b981");
      ctx.fillRect(bx + 1, sy, l.barW - 2, l.segH);
    }

    if (peakHolds[i] > 0.01) {
      const pkY = Math.round(scalarToY(peakHolds[i])) + 0.5;
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(bx, pkY);
      ctx.lineTo(bx + l.barW, pkY);
      ctx.stroke();
      ctx.lineWidth = 1;
    }
  }

  // 3. Limiter threshold line and LIMIT badge
  const threshY = Math.round(threshYExact) + 0.5;
  const isCeilActive = isDraggingCeiling || isCeilingHovered;
  ctx.strokeStyle = isCeilActive ? "#ff4d79" : "#ff2a5f";
  ctx.lineWidth = isCeilActive ? 2 : 1.5;
  if (isCeilActive) {
    ctx.shadowColor = "rgba(255, 42, 95, 0.6)";
    ctx.shadowBlur = 8;
  }
  ctx.beginPath();
  ctx.moveTo(METER_PAD.left - 2, threshY);
  ctx.lineTo(METER_PAD.left + l.availW - 6, threshY);
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.lineWidth = 1;

  const badgeW = 92;
  const badgeH = 20;
  const badgeX = METER_PAD.left + l.availW - badgeW - 6;
  ctx.fillStyle = "#ff2a5f";
  ctx.beginPath();
  ctx.roundRect(badgeX, Math.round(threshY - badgeH / 2), badgeW, badgeH, 4);
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.font = "800 10.5px 'JetBrains Mono', monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(`LIMIT: ${state.threshold_db.toFixed(0)} dB`, badgeX + badgeW / 2, threshY);

  // 4. Gain reduction readout and LED bars
  const grTarget = Math.abs(state.gain_reduction_db);
  smoothGR += (grTarget - smoothGR) * (1.0 - Math.exp(-dt / 0.06));
  if (Math.abs(grTarget - smoothGR) > 0.02) settling = true;
  else smoothGR = grTarget;

  ctx.fillStyle = "#ff2a5f";
  ctx.font = "800 11px 'JetBrains Mono', monospace";
  ctx.fillText(`GR  ${smoothGR > 0.1 ? `-${smoothGR.toFixed(1)}` : "-0.0"} dB`, l.grX + l.grW / 2, top + 14);

  for (let b = 0; b < GR_BAR_THRESHOLDS.length; b++) {
    if (smoothGR < GR_BAR_THRESHOLDS[b]) break;
    ctx.fillStyle = l.grGradients[b];
    ctx.beginPath();
    ctx.roundRect(l.grX + 8, l.grBarsStartY + b * 12, l.grBarW, 7, 3);
    ctx.fill();
  }

  // Keep animating only while something is still moving; otherwise go fully idle
  if (settling || histNonZero > 0 || isDraggingCeiling) {
    rafId = requestAnimationFrame(renderMeter);
  }
}

function getCeilingY() {
  if (!layout) return 0;
  return dbToY(state.threshold_db);
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
    if (!isCeilingHovered) {
      isCeilingHovered = true;
      canvas.style.cursor = "ns-resize";
      requestRender();
    }
  } else if (isCeilingHovered) {
    isCeilingHovered = false;
    canvas.style.cursor = "default";
    requestRender();
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
    requestRender();
  }
});

canvas.addEventListener("mouseleave", () => {
  if (!isDraggingCeiling && isCeilingHovered) {
    isCeilingHovered = false;
    canvas.style.cursor = "default";
    requestRender();
  }
});

window.addEventListener("mouseup", () => {
  if (isDraggingCeiling) {
    isDraggingCeiling = false;
    canvas.style.cursor = isCeilingHovered ? "ns-resize" : "default";
    showToast(`Ceiling: ${state.threshold_db.toFixed(1)} dB`, "info");
    requestRender();
  }
});

// Non-blocking toasts. Messages that share a topic (the text before the first colon) update the
// toast already on screen instead of stacking, so dragging a slider never floods the corner.
const TOAST_LIMIT = 4;
const TOAST_ICONS = { info: "⚡", warning: "⚠️", success: "🛡️" };
const activeToasts = new Map();

function showToast(message, type = "info") {
  const container = document.getElementById("toastContainer");
  if (!container) return;
  const text = String(message);
  const topic = text.split(":")[0].trim().toLowerCase();

  let entry = activeToasts.get(topic);
  if (entry) {
    entry.el.className = `toast toast-${type} show`;
    entry.icon.textContent = TOAST_ICONS[type] || TOAST_ICONS.info;
    entry.label.textContent = text;
    entry.el.classList.remove("bump");
    void entry.el.offsetWidth;
    entry.el.classList.add("bump");
    clearTimeout(entry.timer);
  } else {
    if (activeToasts.size >= TOAST_LIMIT) {
      const [oldestTopic, oldest] = activeToasts.entries().next().value;
      dismissToast(oldestTopic, oldest);
    }
    const el = document.createElement("div");
    el.className = `toast toast-${type}`;
    el.setAttribute("role", "status");
    const icon = document.createElement("span");
    icon.className = "toast-icon";
    icon.textContent = TOAST_ICONS[type] || TOAST_ICONS.info;
    const label = document.createElement("span");
    label.className = "toast-text";
    label.textContent = text;
    el.append(icon, label);
    container.appendChild(el);
    entry = { el, icon, label, timer: 0 };
    activeToasts.set(topic, entry);
    requestAnimationFrame(() => el.classList.add("show"));
  }
  const current = entry;
  current.timer = setTimeout(() => dismissToast(topic, current), 2200);
}

function dismissToast(topic, entry) {
  clearTimeout(entry.timer);
  if (activeToasts.get(topic) === entry) activeToasts.delete(topic);
  entry.el.classList.remove("show");
  setTimeout(() => entry.el.remove(), 260);
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
  updateMiniHudCeiling();
  requestRender();

  if (window.pywebview && window.pywebview.api) {
    window.pywebview.api.set_threshold(state.threshold_db);
  }
}

function setCeilingDb(db) {
  updateCeiling(db);
  showToast(`Ceiling: ${state.threshold_db.toFixed(1)} dB`, "info");
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

function setKneeMode(mode, silent = false) {
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
  refreshHearingSafeBadge();
  updateGuideLiveBadges();
  if (!silent) showToast(`Dynamics Mode: ${mode === "soft_knee" ? "Soft-Knee (4:1)" : "Brickwall (∞:1)"}`, "info");
}

// Hearing-Safe overrides the knee with a hard cap and a 150 ms combat hold
function setHearingSafe(enabled, silent = false) {
  state.hearing_safe = !!enabled;
  const sw = document.getElementById("hearingSafeSwitch");
  if (sw) sw.checked = state.hearing_safe;
  refreshHearingSafeBadge();
  updateGuideLiveBadges();
  if (!silent) {
    if (window.pywebview && window.pywebview.api && window.pywebview.api.set_hearing_safe) {
      window.pywebview.api.set_hearing_safe(state.hearing_safe);
    }
    showToast(state.hearing_safe ? "Hearing-Safe: On (hard cap + 150 ms combat hold)" : "Hearing-Safe: Off", state.hearing_safe ? "success" : "info");
  }
}

function refreshHearingSafeBadge() {
  const ratioBadge = document.getElementById("dynamicsRatioBadge");
  const noteText = document.getElementById("curveNoteText");
  const card = document.querySelector(".dynamics-col-card");
  if (card) card.classList.toggle("hearing-safe-on", state.hearing_safe);
  if (state.hearing_safe) {
    if (ratioBadge) ratioBadge.innerText = "HARD CAP";
    if (noteText) noteText.innerText = "Hearing-Safe: hard cap + 150 ms combat hold";
  } else {
    if (ratioBadge) ratioBadge.innerText = state.knee_mode === "soft_knee" ? "4:1 RATIO" : "∞:1 RATIO";
    if (noteText) noteText.innerText = state.knee_mode === "soft_knee" ? "Soft-Knee Preserving Distance (4:1)" : "Brickwall Limiter (∞:1)";
  }
}

window.setHearingSafe = setHearingSafe;

function setPillGroup(groupId, value) {
  document.querySelectorAll(`#${groupId} .mini-pill`).forEach(btn => {
    btn.classList.toggle("active", parseFloat(btn.dataset.val) === value);
  });
}

function setCombatGuard(db, silent = false) {
  state.combat_guard_db = db;
  setPillGroup("combatGuardPills", db);
  updateGuideLiveBadges();
  if (!silent) {
    if (window.pywebview && window.pywebview.api && window.pywebview.api.set_combat_guard) {
      window.pywebview.api.set_combat_guard(db);
    }
    showToast(db > 0 ? `Combat Guard: ${db} dB for 4 s after loud shots` : "Combat Guard: Off", db > 0 ? "success" : "info");
  }
}

function setFootstepBoost(db, silent = false) {
  state.footstep_boost_db = db;
  setPillGroup("footstepBoostPills", db);
  updateBoostStatus();
  updateGuideLiveBadges();
  if (!silent) {
    if (window.pywebview && window.pywebview.api && window.pywebview.api.set_footstep_boost) {
      window.pywebview.api.set_footstep_boost(db);
    }
    if (db > 0 && !state.combat_guard_db && !state.hearing_safe) {
      showToast(`Footstep Boost: +${db} dB. Tip: add Combat Guard so first shots stay comfortable`, "info");
    } else {
      showToast(db > 0 ? `Footstep Boost: +${db} dB on the game only` : "Footstep Boost: Off", db > 0 ? "success" : "info");
    }
  }
}

// Explains what the boost is actually doing right now, since it depends on mode and headroom
function updateBoostStatus() {
  const el = document.getElementById("boostStatus");
  if (!el) return;
  const req = state.footstep_boost_db;
  const applied = state.boost_applied_db || 0;
  let text = "Off";
  let cls = "";
  if (req > 0) {
    if (!state.enabled) {
      text = "Paused: limiter is off";
      cls = "warn";
    } else if (state.target_mode === "master_device") {
      text = "Needs Auto-Detect Game or Specific App";
      cls = "warn";
    } else if (!state.is_game_isolated) {
      text = "Waiting for the game to start";
    } else if (applied + 0.05 < req) {
      text = applied > 0.05 ? `Limited to +${applied.toFixed(1)} dB: Windows volume is near max` : "No room: Windows volume is at max";
      cls = "warn";
    } else {
      text = `Active: game +${applied.toFixed(1)} dB, other apps unchanged`;
      cls = "on";
    }
  }
  el.textContent = text;
  el.className = `boost-status ${cls}`;
}

window.setCombatGuard = setCombatGuard;
window.setFootstepBoost = setFootstepBoost;

const SCOPE_LABELS = { auto_game: "Auto-Detect Game", specific_app: "Specific App", master_device: "Master PC" };

function setScope(mode, silent = false) {
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
  if (!silent) showToast(`Clamping Scope: ${SCOPE_LABELS[mode] || mode}`, "info");
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
  showToast(enabled ? "Launch on Startup: Enabled" : "Launch on Startup: Disabled", "info");
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

function makeOption(value, label, selectedStem) {
  const opt = document.createElement("option");
  opt.value = value;
  opt.textContent = label;
  if (selectedStem && value.toLowerCase().replace(".exe", "") === selectedStem) opt.selected = true;
  return opt;
}

let isStreamScanRunning = false;

// Scan Active Streams: samples every WASAPI session meter briefly and lists apps that are
// producing sound right now at the top, ahead of idle sessions.
async function refreshAudioProcesses(announce = false) {
  const dropdown = document.getElementById("processDropdown");
  if (!dropdown || isStreamScanRunning) return;
  const api = window.pywebview && window.pywebview.api;

  if (api && api.get_audio_streams) {
    isStreamScanRunning = true;
    const scanBtn = document.getElementById("btnScanStreams");
    if (scanBtn) scanBtn.classList.add("scanning");
    dropdown.innerHTML = '<option value="">Listening for active audio streams...</option>';
    try {
      const streams = (await api.get_audio_streams()) || [];
      const selectedStem = (state.target_process || "").toLowerCase().replace(".exe", "");
      dropdown.innerHTML = "";
      dropdown.appendChild(makeOption("", "-- Choose Audio Stream --", ""));

      const live = streams.filter(s => s.producing_sound);
      const idle = streams.filter(s => !s.producing_sound);
      if (live.length) {
        const group = document.createElement("optgroup");
        group.label = "Producing sound now";
        live.forEach(s => group.appendChild(makeOption(s.name, `🔊 ${s.name}  ·  ${s.peak_db} dB`, selectedStem)));
        dropdown.appendChild(group);
      }
      if (idle.length) {
        const group = document.createElement("optgroup");
        group.label = "Idle audio sessions";
        idle.forEach(s => group.appendChild(makeOption(s.name, `${s.session_active ? "◦" : "·"} ${s.name}`, selectedStem)));
        dropdown.appendChild(group);
      }
      if (!streams.length) {
        const opt = makeOption("", "No audio sessions found (start the game or use Browse)", "");
        opt.disabled = true;
        dropdown.appendChild(opt);
      }
      if (announce) {
        showToast(`Stream Scan: ${live.length} producing sound, ${idle.length} idle`, live.length ? "success" : "info");
      }
    } catch (e) {
      dropdown.innerHTML = '<option value="">-- Manual .exe Input Below --</option>';
      if (announce) showToast("Stream Scan: failed to query audio sessions", "warning");
    } finally {
      isStreamScanRunning = false;
      if (scanBtn) scanBtn.classList.remove("scanning");
    }
    return;
  }

  dropdown.innerHTML = '<option value="">Scanning Active Audio Games/Apps...</option>';
  if (api && api.get_audio_processes) {
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
  setFootstepBoost(0, true);
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

  const pSafe = document.getElementById("guideBadge_hearingsafe");
  if (pSafe) {
    pSafe.innerText = state.hearing_safe ? "LIVE: On" : "LIVE: Off";
    pSafe.style.borderColor = state.hearing_safe ? "var(--accent-emerald)" : "var(--border-subtle)";
    pSafe.style.color = state.hearing_safe ? "var(--accent-emerald)" : "var(--text-muted)";
  }

  const pGuard = document.getElementById("guideBadge_guard");
  if (pGuard) pGuard.innerText = state.combat_guard_db > 0 ? `LIVE: -${state.combat_guard_db} dB` : "LIVE: Off";
  const pBoost = document.getElementById("guideBadge_boost");
  if (pBoost) pBoost.innerText = state.footstep_boost_db > 0 ? `LIVE: +${state.footstep_boost_db} dB` : "LIVE: Off";

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
  lastRenderTime = performance.now();
  updateCanvasDimensions();
  requestRender();
};

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    window.onWindowHidden();
  } else {
    window.onWindowShown();
  }
});

window.receiveTelemetry = function(data) {
  const prevPeak = state.peak;
  const prevGr = state.gain_reduction_db;
  state.peak = data.peak || 0.0;
  state.output_peak = data.output_peak ?? (data.peak || 0.0);
  state.channel_peaks = data.channel_peaks || [state.peak, state.peak];
  state.gain_reduction_db = data.gain_reduction_db || 0.0;
  state.is_app_running = data.is_app_running ?? true;
  state.auto_watch_status = data.auto_watch_status || "";

  state.boost_applied_db = data.footstep_boost_db || 0;
  const guardNow = !!data.combat_guard_active;
  if (guardNow !== state.combat_guard_active) {
    state.combat_guard_active = guardNow;
    const badge = document.getElementById("guardBadge");
    if (badge) badge.classList.toggle("on", guardNow);
  }

  const now = performance.now();
  pushHistory(state.peak, state.output_peak, now);
  // Only wake the canvas when there is something new to draw
  if (state.peak > 0.0001 || prevPeak > 0.0001 || state.gain_reduction_db !== prevGr) {
    requestRender();
  }
  if (state.mini_mode) updateMiniHud();

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

  // Telemetry already arrives at 20 Hz; the guard only protects against bursts
  if (now - lastTextUpdateTime >= 40) {
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

    updateBoostStatus();
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

  state.hearing_safe = cfg.hearing_safe ?? false;
  setKneeMode(state.knee_mode, true);
  setHearingSafe(state.hearing_safe, true);
  setCombatGuard(cfg.combat_guard_db ?? 0, true);
  setFootstepBoost(cfg.footstep_boost_db ?? 0, true);

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
  setScope(state.target_mode, true);
  updateGuideLiveBadges();
};

function initWindowDrag(titlebar, allowMaximize) {
  if (!titlebar) return;

  let isDragging = false;
  let startX = 0;
  let startY = 0;

  titlebar.addEventListener("dblclick", (e) => {
    if (!allowMaximize || state.mini_mode) return;
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
  initWindowDrag(document.querySelector(".titlebar"), true);
  initWindowDrag(document.querySelector(".mini-hud-bar"), false);
  updateMiniHudCeiling();
  updateMiniHudStatus();
  updateSliderTrack(document.getElementById("ceilingSlider"), "#ff2a5f");
  updateSliderTrack(document.getElementById("releaseSlider"), "#00f2fe");
  updateQuickCeilingButtons(state.threshold_db);

  const cSlider = document.getElementById("ceilingSlider");
  if (cSlider) {
    cSlider.addEventListener("input", (e) => {
      updateCeiling(parseFloat(e.target.value));
    });
    cSlider.addEventListener("change", () => {
      showToast(`Ceiling: ${state.threshold_db.toFixed(1)} dB`, "info");
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
      updateMiniHudStatus();
      if (window.pywebview && window.pywebview.api) {
        window.pywebview.api.toggle_enabled(enabled);
      }
      showToast(enabled ? "Peak Limiter: Online" : "Peak Limiter: Off", enabled ? "success" : "warning");
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
      if (state.mini_mode) return;
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

// ==========================================
// Compact HUD / Mini-Player Mode (Ctrl+Alt+M)
// ==========================================
// The backend shrinks the window and pins it on top; this side swaps the layout. While the
// HUD is showing, the main canvas stays idle and readouts update through CSS transforms only.

const miniEls = {};
function miniEl(id) {
  if (!miniEls[id]) miniEls[id] = document.getElementById(id);
  return miniEls[id];
}

function meterNorm(db) {
  return Math.max(0, Math.min(1, (db - METER_MIN_DB) / (METER_MAX_DB - METER_MIN_DB)));
}

function setMiniModeUI(enabled) {
  state.mini_mode = !!enabled;
  document.body.classList.toggle("mini-mode", state.mini_mode);
  const btn = document.getElementById("btnMiniMode");
  if (btn) btn.classList.toggle("active", state.mini_mode);

  if (state.mini_mode) {
    if (isDeviceMenuOpen) closeDeviceMenu();
    closeSettingsGuide();
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    updateMiniHud();
    updateMiniHudCeiling();
    updateMiniHudStatus();
  } else {
    lastRenderTime = performance.now();
    requestAnimationFrame(() => updateCanvasDimensions());
    showToast("Compact HUD: Full view restored", "info");
  }
}

async function toggleMiniMode() {
  const api = window.pywebview && window.pywebview.api;
  if (api && api.toggle_mini_mode) {
    // The backend resizes the window and then calls setMiniModeUI()
    await api.toggle_mini_mode();
  } else {
    setMiniModeUI(!state.mini_mode);
  }
}

function updateMiniHud() {
  const pk = state.peak;
  const silent = pk <= 0.0001;
  const pkDb = silent ? METER_MIN_DB : 20.0 * Math.log10(pk);
  const gr = Math.abs(state.gain_reduction_db);

  const peakVal = miniEl("miniPeakVal");
  if (peakVal) peakVal.textContent = silent ? "-∞" : pkDb.toFixed(1);
  const grVal = miniEl("miniGrVal");
  if (grVal) grVal.textContent = gr > 0.1 ? `-${gr.toFixed(1)}` : "0.0";

  const fill = miniEl("miniMeterFill");
  if (fill) fill.style.transform = `scaleX(${silent ? 0 : meterNorm(pkDb)})`;
  const outFill = miniEl("miniMeterOut");
  if (outFill) {
    const outDb = state.output_peak > 0.0001 ? 20.0 * Math.log10(state.output_peak) : METER_MIN_DB;
    outFill.style.transform = `scaleX(${meterNorm(outDb)})`;
  }
  const grFill = miniEl("miniGrFill");
  if (grFill) grFill.style.transform = `scaleX(${Math.min(1, gr / 12)})`;

  const hud = miniEl("miniHud");
  if (hud) hud.classList.toggle("clamping", gr > 0.1);
}

function updateMiniHudCeiling() {
  const limitVal = miniEl("miniLimitVal");
  if (limitVal) limitVal.textContent = state.threshold_db.toFixed(1);
  const marker = miniEl("miniMeterCeiling");
  if (marker) marker.style.left = `${meterNorm(state.threshold_db) * 100}%`;
}

function updateMiniHudStatus() {
  const status = miniEl("miniHudStatus");
  if (!status) return;
  status.textContent = state.enabled ? "ONLINE" : "OFF";
  status.classList.toggle("off", !state.enabled);
}

window.setMiniModeUI = setMiniModeUI;
window.toggleMiniMode = toggleMiniMode;

// ==========================================
// Acoustic Test Sandbox (Web Audio synthesis)
// ==========================================
// Everything is synthesized in the browser: no media files. While the test plays, the backend
// adds this window's own audio session to the clamp targets, so the gunshots run through the
// limiter exactly like game audio would and the meters show the result.

const AudioTest = (() => {
  const DURATION = 5.4;
  const MASTER_LEVEL = 0.8;
  let ac = null;
  let endTimer = 0;

  function noiseBuffer(ctxA, seconds, pink) {
    const len = Math.floor(ctxA.sampleRate * seconds);
    const buf = ctxA.createBuffer(1, len, ctxA.sampleRate);
    const d = buf.getChannelData(0);
    if (!pink) {
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      return buf;
    }
    // Paul Kellet's refined pink noise filter
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.96900 * b2 + w * 0.1538520;
      b3 = 0.86650 * b3 + w * 0.3104856;
      b4 = 0.55000 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.0168980;
      d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
      b6 = w * 0.115926;
    }
    return buf;
  }

  // Decaying stereo noise works as a convincing room/outdoor reverb tail
  function impulseResponse(ctxA, seconds, decay) {
    const len = Math.floor(ctxA.sampleRate * seconds);
    const buf = ctxA.createBuffer(2, len, ctxA.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
    return buf;
  }

  function panner(ctxA, dest, pan) {
    const p = ctxA.createStereoPanner();
    p.pan.value = pan;
    p.connect(dest);
    return p;
  }

  function gunshot(ctxA, out, verb, white, t, level, pan) {
    const p = panner(ctxA, out, pan);
    const send = ctxA.createGain();
    send.gain.value = 0.55;
    p.connect(send);
    send.connect(verb);

    // Crack: broadband burst under a falling lowpass, sub-millisecond attack
    const n = ctxA.createBufferSource();
    n.buffer = white;
    const lp = ctxA.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(11000, t);
    lp.frequency.exponentialRampToValueAtTime(1400, t + 0.09);
    const g = ctxA.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(level, t + 0.0008);
    g.gain.exponentialRampToValueAtTime(level * 0.25, t + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
    n.connect(lp).connect(g).connect(p);
    n.start(t, Math.random() * 0.5);
    n.stop(t + 0.25);

    // Body: pitched-down low thump
    const o = ctxA.createOscillator();
    o.type = "sine";
    o.frequency.setValueAtTime(140, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.16);
    const og = ctxA.createGain();
    og.gain.setValueAtTime(0.0001, t);
    og.gain.exponentialRampToValueAtTime(level * 0.7, t + 0.002);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
    o.connect(og).connect(p);
    o.start(t);
    o.stop(t + 0.3);
  }

  // Heel and toe taps, band-limited to the 1-4 kHz region where footsteps carry
  function footstep(ctxA, out, white, t, level, pan) {
    const p = panner(ctxA, out, pan);
    const taps = [[0, 1500, 1.0], [0.045, 2800, 0.7]];
    for (const [off, freq, lv] of taps) {
      const n = ctxA.createBufferSource();
      n.buffer = white;
      const bp = ctxA.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = freq;
      bp.Q.value = 1.4;
      const g = ctxA.createGain();
      const ts = t + off;
      g.gain.setValueAtTime(0.0001, ts);
      g.gain.exponentialRampToValueAtTime(level * lv, ts + 0.002);
      g.gain.exponentialRampToValueAtTime(0.0001, ts + 0.07);
      n.connect(bp).connect(g).connect(p);
      n.start(ts, Math.random() * 0.5);
      n.stop(ts + 0.1);
    }
  }

  function setButtonUI(playing) {
    state.audio_test_active = playing;
    const btn = document.getElementById("btnTestAudio");
    const label = document.getElementById("testAudioLabel");
    if (btn) {
      btn.style.setProperty("--test-duration", `${DURATION}s`);
      btn.classList.toggle("playing", playing);
    }
    if (label) label.textContent = playing ? "Stop Test" : "Test Audio";
  }

  async function start() {
    if (ac) {
      stop("Test Audio: stopped");
      return;
    }
    if (!state.enabled) {
      showToast("Test Audio: turn the Peak Limiter on first so the shots get clamped", "warning");
      return;
    }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) {
      showToast("Test Audio: Web Audio is not available in this view", "warning");
      return;
    }

    const api = window.pywebview && window.pywebview.api;
    if (api && api.begin_audio_test) {
      try { await api.begin_audio_test(); } catch (_) {}
    }

    ac = new Ctx({ latencyHint: "interactive" });
    const master = ac.createGain();
    master.gain.value = MASTER_LEVEL;
    master.connect(ac.destination);

    const verb = ac.createConvolver();
    verb.buffer = impulseResponse(ac, 1.4, 3.0);
    const wet = ac.createGain();
    wet.gain.value = 0.3;
    verb.connect(wet).connect(master);

    const white = noiseBuffer(ac, 1.0, false);
    const t0 = ac.currentTime + 0.08;

    // Quiet ambience bed around -40 dBFS
    const bed = ac.createBufferSource();
    bed.buffer = noiseBuffer(ac, DURATION, true);
    const bedGain = ac.createGain();
    bedGain.gain.setValueAtTime(0.0001, t0);
    bedGain.gain.exponentialRampToValueAtTime(0.012, t0 + 0.3);
    bedGain.gain.setValueAtTime(0.012, t0 + DURATION - 0.4);
    bedGain.gain.exponentialRampToValueAtTime(0.0001, t0 + DURATION);
    bed.connect(bedGain).connect(master);
    bed.start(t0);
    bed.stop(t0 + DURATION);

    // Footsteps run through the whole clip, so recovery after the shots is audible
    let step = 0;
    for (let t = 0.0; t < DURATION - 0.3; t += 0.42) {
      footstep(ac, master, white, t0 + t, 0.04, step % 2 ? 0.35 : -0.35);
      step++;
    }

    // A 3-round burst, then one heavy close shot. The first shot lands at 1.6 s, which leaves
    // the engine time to pick up this window's audio session.
    [1.6, 1.71, 1.82].forEach(t => gunshot(ac, master, verb, white, t0 + t, 0.5, 0.15));
    gunshot(ac, master, verb, white, t0 + 3.1, 0.56, -0.2);

    setButtonUI(true);
    showToast("Test Audio: footsteps, a 3-round burst, then one heavy shot", "info");
    endTimer = setTimeout(() => stop(), (DURATION + 0.25) * 1000);
  }

  function stop(message) {
    clearTimeout(endTimer);
    if (ac) {
      ac.close().catch(() => {});
      ac = null;
    }
    const api = window.pywebview && window.pywebview.api;
    if (api && api.end_audio_test) {
      try { api.end_audio_test(); } catch (_) {}
    }
    setButtonUI(false);
    showToast(message || "Test Audio: done. The GR meter shows how hard each shot was clamped", "success");
  }

  return { start, stop, isPlaying: () => ac !== null };
})();

function toggleAudioTest() {
  AudioTest.start();
}

window.toggleAudioTest = toggleAudioTest;
