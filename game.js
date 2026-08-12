import {
  newGame, resolveCommission, currentCommission, shareText,
  shapeFromFeatures, CRAFT_LABELS, mulberry32,
} from './guild.mjs';

const STORAGE_KEY = 'jman_v1';

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.seed !== 'number') return null;
    return parsed;
  } catch (e) { return null; }
}
function saveState(state) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { /* ignore */ }
}

let state = loadState() || newGame((Date.now() % 2147483647) >>> 0);
let lastResult = null;

// --- screens ---------------------------------------------------------------
const screens = {};
document.querySelectorAll('.screen').forEach(el => { screens[el.id.replace('screen-', '')] = el; });
function showScreen(name) {
  Object.entries(screens).forEach(([k, el]) => el.classList.toggle('active', k === name));
  currentScreen = name;
}
let currentScreen = 'title';

// --- reputation pips ---------------------------------------------------
const repPips = document.getElementById('repPips');
function renderRepPips() {
  repPips.innerHTML = '';
  const filled = Math.round(Math.min(state.reputation, 10));
  for (let i = 0; i < 10; i++) {
    const pip = document.createElement('div');
    pip.className = 'rep-pip' + (i < filled ? ' filled' : '');
    repPips.appendChild(pip);
  }
}

// --- canvas rendering ----------------------------------------------------
function drawShape(canvas, vec, seedForShape, opts = {}) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  const pts = shapeFromFeatures(vec, seedForShape);
  const cx = w / 2, cy = h / 2, scale = 1.6;
  ctx.beginPath();
  pts.forEach((p, i) => {
    const x = cx + p.x * scale, y = cy + p.y * scale;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.closePath();
  ctx.strokeStyle = opts.stroke || '#d99a44';
  ctx.lineWidth = opts.lineWidth || 2.5;
  ctx.globalAlpha = opts.alpha !== undefined ? opts.alpha : 1;
  if (opts.setLineDash) ctx.setLineDash(opts.setLineDash);
  ctx.stroke();
  if (opts.fill) {
    ctx.globalAlpha = (opts.alpha !== undefined ? opts.alpha : 1) * 0.15;
    ctx.fillStyle = opts.fill;
    ctx.fill();
  }
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
}

function drawStrokePoints(canvas, points) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  if (!points || points.length < 2) return;
  ctx.beginPath();
  points.forEach((p, i) => { if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y); });
  ctx.strokeStyle = '#efe1c8';
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.stroke();
}

// --- commission-specific shape seed: stable per commissionIndex --------
function shapeSeedFor(index) { return (index * 104729 + 7) >>> 0; }

// --- play screen -----------------------------------------------------
const commissionCraftEl = document.getElementById('commissionCraft');
const demoCountEl = document.getElementById('demoCount');
const refCanvas = document.getElementById('refCanvas');
const workCanvas = document.getElementById('workCanvas');

function renderPlayScreen() {
  const commission = currentCommission(state);
  commissionCraftEl.textContent = `the guild wants ${CRAFT_LABELS[commission.craft]}`;
  demoCountEl.textContent = `${state.demonstrations.length} demonstrations taught`;
  drawShape(refCanvas, commission.target, shapeSeedFor(state.commissionIndex));
  const ctx = workCanvas.getContext('2d');
  ctx.clearRect(0, 0, workCanvas.width, workCanvas.height);
  strokePoints = [];
  renderRepPips();
}

// --- stroke capture (pointer events) -----------------------------------
let strokePoints = [];
let drawing = false;

function canvasPoint(evt) {
  const rect = workCanvas.getBoundingClientRect();
  const scaleX = workCanvas.width / rect.width;
  const scaleY = workCanvas.height / rect.height;
  return {
    x: (evt.clientX - rect.left) * scaleX,
    y: (evt.clientY - rect.top) * scaleY,
    t: evt.timeStamp,
  };
}
workCanvas.addEventListener('pointerdown', (evt) => {
  drawing = true;
  strokePoints = [canvasPoint(evt)];
  workCanvas.setPointerCapture(evt.pointerId);
});
workCanvas.addEventListener('pointermove', (evt) => {
  if (!drawing) return;
  strokePoints.push(canvasPoint(evt));
  drawStrokePoints(workCanvas, strokePoints);
});
function endStroke(evt) {
  if (!drawing) return;
  drawing = false;
  strokePoints.push(canvasPoint(evt));
  drawStrokePoints(workCanvas, strokePoints);
}
workCanvas.addEventListener('pointerup', endStroke);
workCanvas.addEventListener('pointercancel', endStroke);

// --- resolving a commission ---------------------------------------------
const resultCraftEl = document.getElementById('resultCraft');
const resultTaughtEl = document.getElementById('resultTaught');
const resultRefCanvas = document.getElementById('resultRefCanvas');
const resultAttemptCanvas = document.getElementById('resultAttemptCanvas');
const gradeBigEl = document.getElementById('gradeBig');
const gradeSubEl = document.getElementById('gradeSub');
const unlockBanner = document.getElementById('unlockBanner');

function resolve(demoPointsOrNull) {
  const beforeCrafts = state.unlockedCrafts.slice();
  const commissionIndexBefore = state.commissionIndex;
  const { state: newState, result } = resolveCommission(state, demoPointsOrNull, 3);
  state = newState;
  lastResult = result;
  saveState(state);

  resultCraftEl.textContent = CRAFT_LABELS[result.craft];
  resultTaughtEl.textContent = demoPointsOrNull ? 'taught this round' : 'held back this round';
  drawShape(resultRefCanvas, result.target, shapeSeedFor(commissionIndexBefore), { stroke: '#9a6f3c', setLineDash: [4, 3] });
  drawShape(resultAttemptCanvas, result.attempt, shapeSeedFor(commissionIndexBefore), { stroke: '#f0b866', fill: '#f0b866' });
  gradeBigEl.textContent = `${result.grade}/10`;
  gradeSubEl.textContent = `reputation ${result.reputation.toFixed(1)} / 10`;

  const newlyUnlocked = state.unlockedCrafts.filter(c => !beforeCrafts.includes(c));
  if (newlyUnlocked.length) {
    unlockBanner.style.display = 'block';
    unlockBanner.textContent = `The guild trusts the workshop with a new craft: ${newlyUnlocked.map(c => CRAFT_LABELS[c]).join(', ')}.`;
  } else {
    unlockBanner.style.display = 'none';
  }

  renderRepPips();

  if (state.graduated) {
    renderGraduateScreen();
    showScreen('graduate');
  } else {
    showScreen('result');
  }
  return result;
}

// --- graduate screen -----------------------------------------------------
const graduateLine = document.getElementById('graduateLine');
function renderGraduateScreen() {
  const last = state.history[state.history.length - 1];
  const label = last ? CRAFT_LABELS[last.craft] : 'the piece';
  graduateLine.textContent = `The apprentice finished ${label} alone, and the guild called it good.`;
}

// --- share ---------------------------------------------------------------
function doShare(boxEl) {
  const text = shareText(state, 'journeyman');
  boxEl.style.display = 'block';
  boxEl.textContent = text;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).catch(() => { /* clipboard may be unavailable */ });
  }
}

// --- wiring ----------------------------------------------------------------
document.getElementById('btnStart').addEventListener('click', () => { renderPlayScreen(); showScreen('play'); });
document.getElementById('btnHowTo').addEventListener('click', () => showScreen('howto'));
document.getElementById('btnHowToBack').addEventListener('click', () => showScreen('title'));

document.getElementById('btnTeach').addEventListener('click', () => {
  const points = strokePoints.length >= 2 ? strokePoints.slice() : null;
  resolve(points);
});
document.getElementById('btnDecline').addEventListener('click', () => resolve(null));

document.getElementById('btnNext').addEventListener('click', () => { renderPlayScreen(); showScreen('play'); });
document.getElementById('btnShare').addEventListener('click', () => doShare(document.getElementById('shareBox')));
document.getElementById('btnShareGrad').addEventListener('click', () => doShare(document.getElementById('shareBoxGrad')));
document.getElementById('btnFreePlay').addEventListener('click', () => { renderPlayScreen(); showScreen('play'); });

document.getElementById('btnReset').addEventListener('click', (evt) => {
  evt.preventDefault();
  state = newGame((Date.now() % 2147483647) >>> 0);
  saveState(state);
  showScreen('title');
});

renderRepPips();

// --- dev hook: ?dev=1 exposes window.__g for scripted headless driving ---
if (new URLSearchParams(location.search).get('dev') === '1') {
  window.__g = {
    getState: () => JSON.parse(JSON.stringify(state)),
    getScreen: () => currentScreen,
    getScreens: () => Object.keys(screens),
    goto: (name) => { if (screens[name]) { if (name === 'play') renderPlayScreen(); showScreen(name); } },
    currentCommission: () => currentCommission(state),
    lastResult: () => lastResult,
    // synthetic stroke generator for scripted tests: deterministic, seeded
    syntheticStroke: (seed, n = 12) => {
      const rng = mulberry32(seed >>> 0);
      const pts = [];
      let x = 40, y = 40, t = 0;
      for (let i = 0; i < n; i++) {
        x += (rng() - 0.5) * 40; y += (rng() - 0.5) * 40; t += 10 + Math.floor(rng() * 40);
        pts.push({ x, y, t });
      }
      return pts;
    },
    teach: (strokePointsArg) => resolve(strokePointsArg && strokePointsArg.length >= 2 ? strokePointsArg : null),
    decline: () => resolve(null),
    shareText: () => shareText(state, 'journeyman'),
    resetGame: (seed) => { state = newGame((seed ?? 1) >>> 0); saveState(state); renderPlayScreen(); showScreen('play'); },
  };
}
