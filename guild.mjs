// JOURNEYMAN — pure core. No DOM, no WebAudio, no Date.now(), no Math.random().
// Every random draw and every timestamp is an injected argument.

export const CRAFTS = ['pottery', 'smith', 'joinery'];
export const CRAFT_LABELS = { pottery: 'the guild bowl', smith: 'the guild hinge', joinery: 'the guild joint' };
const DIMS = 5; // [curvature, symmetry, speedMean, speedVar, aspect]
const MAX_DIST = Math.sqrt(DIMS);

export function clamp01(v) { return Math.max(0, Math.min(1, v)); }
export function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// mulberry32 — deterministic PRNG, seeded, no global state.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- Stroke featurizer ---------------------------------------------------
// points: [{x,y,t}, ...] with t = ms timestamp (injected, monotonic).
// Returns a 5-dim vector, every component clamped into [0,1].
export function featurizeStroke(points) {
  if (!points || points.length < 2) return [0, 0, 0, 0, 1];

  let totalLen = 0;
  const segLens = [];
  for (let i = 1; i < points.length; i++) {
    const dx = points[i].x - points[i - 1].x;
    const dy = points[i].y - points[i - 1].y;
    const d = Math.hypot(dx, dy);
    segLens.push(d);
    totalLen += d;
  }
  const first = points[0], last = points[points.length - 1];
  const net = Math.hypot(last.x - first.x, last.y - first.y);
  const straightness = totalLen > 0 ? clamp01(net / totalLen) : 1;
  const curvature = clamp01(1 - straightness);

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, sumX = 0;
  for (const p of points) {
    sumX += p.x;
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const cx = sumX / points.length;
  const width = Math.max(maxX - minX, 1e-6);
  const height = Math.max(maxY - minY, 1e-6);

  const mid = Math.max(1, Math.floor(points.length / 2));
  const firstHalf = points.slice(0, mid);
  const secondHalf = points.slice(mid);
  const meanX1 = firstHalf.reduce((s, p) => s + p.x, 0) / firstHalf.length;
  const meanX2 = secondHalf.length ? secondHalf.reduce((s, p) => s + p.x, 0) / secondHalf.length : meanX1;
  const skew = Math.abs((meanX1 - cx) + (meanX2 - cx)) / width;
  const symmetry = clamp01(1 - skew * 2);

  const speeds = [];
  for (let i = 1; i < points.length; i++) {
    const dt = Math.max(points[i].t - points[i - 1].t, 1);
    speeds.push(segLens[i - 1] / dt);
  }
  const SPEED_SCALE = 2; // px/ms normalization constant
  const speedMeanRaw = speeds.reduce((s, v) => s + v, 0) / speeds.length;
  const speedMean = clamp01(speedMeanRaw / SPEED_SCALE);
  const speedVarRaw = speeds.reduce((s, v) => s + (v - speedMeanRaw) ** 2, 0) / speeds.length;
  const speedVar = clamp01(Math.sqrt(speedVarRaw) / SPEED_SCALE);

  const aspect = clamp01(Math.min(width, height) / Math.max(width, height));

  return [curvature, symmetry, speedMean, speedVar, aspect];
}

export function vectorDistance(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; s += d * d; }
  return Math.sqrt(s);
}

export function makeDemo(vector, craft) {
  return { features: vector.slice(), craft };
}

// --- k-NN learner ----------------------------------------------------------
export function kNearest(demonstrations, targetVec, k) {
  const scored = demonstrations.map((d, i) => ({ demo: d, distance: vectorDistance(d.features, targetVec), i }));
  scored.sort((a, b) => a.distance - b.distance || a.i - b.i);
  return scored.slice(0, Math.max(1, Math.min(k, scored.length)));
}

// Weighted-centroid attempt with noise proportional to neighbor disagreement.
// This is the honest core claim: a tight cluster of neighbors -> low noise,
// a scattered cluster ("sloppy" demonstrations) -> the apprentice's attempt
// inherits that scatter.
export function predictAttempt(demonstrations, targetVec, k, rng) {
  if (!demonstrations || demonstrations.length === 0) return [0.5, 0.5, 0.5, 0.5, 0.5];
  const neighbors = kNearest(demonstrations, targetVec, k);
  const dims = targetVec.length;
  const weights = neighbors.map(n => 1 / (n.distance + 1e-6));
  const wSum = weights.reduce((s, w) => s + w, 0);
  const centroid = new Array(dims).fill(0);
  neighbors.forEach((n, idx) => {
    for (let d = 0; d < dims; d++) centroid[d] += n.demo.features[d] * (weights[idx] / wSum);
  });

  let spread = 0;
  if (neighbors.length > 1) {
    let sum = 0, pairs = 0;
    for (let a = 0; a < neighbors.length; a++) {
      for (let b = a + 1; b < neighbors.length; b++) {
        sum += vectorDistance(neighbors[a].demo.features, neighbors[b].demo.features);
        pairs++;
      }
    }
    spread = pairs > 0 ? sum / pairs : 0;
  }
  const noiseScale = spread * 0.5;
  return centroid.map(v => clamp01(v + (rng() - 0.5) * 2 * noiseScale));
}

export function gradeAttempt(attempt, target) {
  const d = vectorDistance(attempt, target);
  const raw = 10 * (1 - d / MAX_DIST);
  return clamp(Math.round(raw), 0, 10);
}

// --- Curriculum analytics (shown to the player as teaching feedback) ------
export function demoConsistency(demos) {
  if (!demos || demos.length < 2) return 1;
  let sum = 0, pairs = 0;
  for (let a = 0; a < demos.length; a++) {
    for (let b = a + 1; b < demos.length; b++) { sum += vectorDistance(demos[a].features, demos[b].features); pairs++; }
  }
  return clamp01(1 - (sum / pairs) / MAX_DIST);
}

export function demoVariety(demos) {
  if (!demos || demos.length < 2) return 0;
  const dims = demos[0].features.length;
  const mean = new Array(dims).fill(0);
  demos.forEach(d => { for (let i = 0; i < dims; i++) mean[i] += d.features[i] / demos.length; });
  let varSum = 0;
  demos.forEach(d => { varSum += vectorDistance(d.features, mean) ** 2; });
  const std = Math.sqrt(varSum / demos.length);
  return clamp01(std / (MAX_DIST / 2));
}

// --- Commissions -------------------------------------------------------
export function generateCommission(seed, index, unlockedCrafts) {
  const rng = mulberry32(((seed >>> 0) ^ Math.imul(index + 1, 2654435761)) >>> 0);
  const craft = unlockedCrafts[index % unlockedCrafts.length];
  const target = [rng(), rng(), rng(), rng(), rng()];
  return { craft, target, index };
}

// --- Decorative shape renderer (deterministic, used by game.js to draw) ---
export function shapeFromFeatures(vec, seed) {
  const [curvature, symmetry, speedMean, speedVar, aspect] = vec;
  const rng = mulberry32((Math.floor(seed) >>> 0) || 1);
  const N = 28;
  const baseR = 40;
  const pts = [];
  for (let i = 0; i < N; i++) {
    const angle = (i / N) * Math.PI * 2;
    const wobble = curvature * 0.6 * Math.sin(angle * 3 + rng() * Math.PI) * baseR * 0.3;
    const asym = (1 - symmetry) * Math.sin(angle) * baseR * 0.25;
    const jitter = speedVar * (rng() - 0.5) * baseR * 0.15;
    const rx = baseR * (0.6 + 0.4 * aspect);
    const ry = baseR;
    const r = Math.min(rx, ry) + wobble + asym + jitter;
    pts.push({ x: Math.cos(angle) * r, y: Math.sin(angle) * r });
  }
  void speedMean;
  return pts;
}

// --- Game state --------------------------------------------------------
export function newGame(seed) {
  return {
    seed: seed >>> 0,
    commissionIndex: 0,
    reputation: 0,
    unlockedCrafts: ['pottery'],
    demonstrations: [],
    graduated: false,
    history: [],
  };
}

const K_NEIGHBORS = 3;

// Lower-level: caller supplies a feature vector directly (or null to decline).
export function resolveCommissionWithDemoVector(state, demoVector, k = K_NEIGHBORS) {
  const commission = generateCommission(state.seed, state.commissionIndex, state.unlockedCrafts);
  const rng = mulberry32(((state.seed + state.commissionIndex * 7919 + 17) >>> 0));

  let demonstrations = state.demonstrations;
  if (demoVector) {
    demonstrations = demonstrations.concat([makeDemo(demoVector, commission.craft)]);
  }

  const sameCraft = demonstrations.filter(d => d.craft === commission.craft);
  const pool = sameCraft.length > 0 ? sameCraft : demonstrations;

  const attempt = pool.length === 0
    ? [0.5, 0.5, 0.5, 0.5, 0.5]
    : predictAttempt(pool, commission.target, Math.min(k, pool.length), rng);

  const grade = gradeAttempt(attempt, commission.target);
  const reputation = clamp(state.reputation + grade / 10, 0, 12);

  const unlockedCrafts = state.unlockedCrafts.slice();
  if (reputation >= 3 && !unlockedCrafts.includes('smith')) unlockedCrafts.push('smith');
  if (reputation >= 6 && !unlockedCrafts.includes('joinery')) unlockedCrafts.push('joinery');

  const graduated = reputation >= 10;

  const newState = {
    seed: state.seed,
    commissionIndex: state.commissionIndex + 1,
    reputation,
    unlockedCrafts,
    demonstrations,
    graduated,
    history: state.history.concat([{ craft: commission.craft, grade, taught: !!demoVector }]),
  };
  return {
    state: newState,
    result: { craft: commission.craft, target: commission.target, attempt, grade, reputation, graduated },
  };
}

// Higher-level: caller supplies raw drawn stroke points (or null to decline).
export function resolveCommission(state, demoPoints, k = K_NEIGHBORS) {
  const demoVector = demoPoints ? featurizeStroke(demoPoints) : null;
  return resolveCommissionWithDemoVector(state, demoVector, k);
}

export function currentCommission(state) {
  return generateCommission(state.seed, state.commissionIndex, state.unlockedCrafts);
}

export function shareText(state, sub = 'journeyman') {
  const last = state.history[state.history.length - 1];
  const grade = last ? last.grade : 0;
  const label = last ? (CRAFT_LABELS[last.craft] || 'a piece') : 'a piece';
  return `\u{1F528} JOURNEYMAN · the apprentice finished ${label} alone — ${grade}/10 · I taught with ${state.demonstrations.length} demonstrations · http://${sub}.defimagic.io`;
}
