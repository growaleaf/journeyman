// JOURNEYMAN — headless tests. node test.mjs, exit 0 = green.
import {
  mulberry32, clamp01, featurizeStroke, vectorDistance, makeDemo,
  kNearest, predictAttempt, gradeAttempt, demoConsistency, demoVariety,
  generateCommission, newGame, resolveCommissionWithDemoVector, resolveCommission,
  shareText,
} from './guild.mjs';

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; }
  else { fail++; failures.push(`${name}${detail ? ' — ' + detail : ''}`); }
}
function approx(a, b, eps = 1e-9) { return Math.abs(a - b) <= eps; }

// --- synthetic stroke generator for bounds/determinism tests --------------
function syntheticStroke(rng, n = 12) {
  const pts = [];
  let x = 0, y = 0, t = 0;
  for (let i = 0; i < n; i++) {
    x += (rng() - 0.5) * 40;
    y += (rng() - 0.5) * 40;
    t += 10 + Math.floor(rng() * 60);
    pts.push({ x, y, t });
  }
  return pts;
}

// 1. mulberry32 determinism
{
  const a = mulberry32(42), b = mulberry32(42);
  const seqA = Array.from({ length: 20 }, () => a());
  const seqB = Array.from({ length: 20 }, () => b());
  check('mulberry32 determinism', JSON.stringify(seqA) === JSON.stringify(seqB));
}

// 2. mulberry32 bounds
{
  const rng = mulberry32(7);
  let ok = true;
  for (let i = 0; i < 1000; i++) { const v = rng(); if (v < 0 || v >= 1) ok = false; }
  check('mulberry32 bounds [0,1)', ok);
}

// 3. featurizeStroke determinism
{
  const rng = mulberry32(99);
  const pts = syntheticStroke(rng);
  const v1 = featurizeStroke(pts);
  const v2 = featurizeStroke(pts);
  check('featurizeStroke determinism', JSON.stringify(v1) === JSON.stringify(v2));
}

// 4. featurizeStroke bounds over >=100 synthetic seeds
{
  let ok = true;
  for (let seed = 0; seed < 150; seed++) {
    const rng = mulberry32(seed);
    const pts = syntheticStroke(rng, 5 + (seed % 15));
    const v = featurizeStroke(pts);
    for (const x of v) if (x < 0 || x > 1 || Number.isNaN(x)) ok = false;
  }
  check('featurizeStroke bounds over 150 seeds', ok);
}

// 5. featurizeStroke geometry sanity: straight line has low curvature, zigzag has high curvature
{
  const line = [];
  for (let i = 0; i < 10; i++) line.push({ x: i * 10, y: 0, t: i * 20 });
  const zigzag = [];
  for (let i = 0; i < 10; i++) zigzag.push({ x: i * 5, y: (i % 2 === 0) ? 0 : 30, t: i * 20 });
  const lineV = featurizeStroke(line);
  const zigV = featurizeStroke(zigzag);
  check('geometry: straight line curvature < zigzag curvature', lineV[0] < zigV[0],
    `line=${lineV[0].toFixed(3)} zigzag=${zigV[0].toFixed(3)}`);
  check('geometry: straight line is elongated (low aspect)', lineV[4] < 0.2, `aspect=${lineV[4]}`);
}

// 6. k-NN exact reproduction with a single demonstration (k=1, no noise possible)
{
  const target = [0.9, 0.1, 0.5, 0.5, 0.5];
  const demo = makeDemo([0.2, 0.7, 0.3, 0.9, 0.1], 'pottery');
  const rng = mulberry32(1);
  const attempt = predictAttempt([demo], target, 1, rng);
  check('k-NN: single demo reproduced exactly', JSON.stringify(attempt) === JSON.stringify(demo.features));
}

// 7. k-NN correctness: with multiple demos and k=1, the nearest one is reproduced exactly
{
  const target = [0.5, 0.5, 0.5, 0.5, 0.5];
  const near = makeDemo([0.51, 0.49, 0.5, 0.5, 0.5], 'pottery');
  const far1 = makeDemo([0.0, 0.0, 0.0, 0.0, 0.0], 'pottery');
  const far2 = makeDemo([1.0, 1.0, 1.0, 1.0, 1.0], 'pottery');
  const rng = mulberry32(2);
  const attempt = predictAttempt([far1, near, far2], target, 1, rng);
  check('k-NN: nearest-of-three selected exactly', JSON.stringify(attempt) === JSON.stringify(near.features));
}

// 8. kNearest ordering on a constructed set with known distances
{
  const target = [0, 0, 0, 0, 0];
  const demos = [
    makeDemo([1, 0, 0, 0, 0], 'x'),   // distance 1
    makeDemo([0, 0, 0, 0, 0], 'x'),   // distance 0
    makeDemo([1, 1, 1, 1, 1], 'x'),   // distance sqrt5
  ];
  const ranked = kNearest(demos, target, 3);
  const distances = ranked.map(r => r.distance);
  const sorted = [...distances].sort((a, b) => a - b);
  check('kNearest: returns demos sorted ascending by distance', JSON.stringify(distances) === JSON.stringify(sorted));
  check('kNearest: closest is the exact match', ranked[0].distance === 0);
}

// 9. REQUIRED: consistent+varied demos beat consistent-only on held-out commissions, over seeds
{
  const heldOut = [
    [0.1, 0.1, 0.1, 0.1, 0.5],
    [0.9, 0.1, 0.5, 0.5, 0.5],
    [0.1, 0.9, 0.5, 0.5, 0.5],
    [0.5, 0.5, 0.9, 0.1, 0.5],
    [0.9, 0.9, 0.1, 0.9, 0.5],
  ];
  const K = 3;
  let variedWins = 0, total = 0;
  let variedTotalErr = 0, consistentTotalErr = 0;
  for (let seed = 0; seed < 40; seed++) {
    const rng = mulberry32(1000 + seed);
    const jitter = () => (rng() - 0.5) * 0.03; // tight, consistent cluster noise

    // Consistent-only: every demo clustered tightly around a single point.
    const anchor = [0.1, 0.1, 0.1, 0.1, 0.5];
    const consistentOnly = [];
    for (let i = 0; i < 10; i++) {
      consistentOnly.push(makeDemo(anchor.map(v => clamp01(v + jitter())), 'pottery'));
    }

    // Consistent+varied: tight clusters near EACH held-out commission.
    const variedConsistent = [];
    for (const h of heldOut) {
      for (let i = 0; i < 2; i++) {
        variedConsistent.push(makeDemo(h.map(v => clamp01(v + jitter())), 'pottery'));
      }
    }

    let errVaried = 0, errConsistent = 0;
    for (const target of heldOut) {
      const rngA = mulberry32(5000 + seed);
      const rngB = mulberry32(5000 + seed);
      const attemptVaried = predictAttempt(variedConsistent, target, K, rngA);
      const attemptConsistent = predictAttempt(consistentOnly, target, K, rngB);
      errVaried += vectorDistance(attemptVaried, target);
      errConsistent += vectorDistance(attemptConsistent, target);
    }
    variedTotalErr += errVaried;
    consistentTotalErr += errConsistent;
    total++;
    if (errVaried < errConsistent) variedWins++;
  }
  check('pedagogy: consistent+varied beats consistent-only on average error',
    variedTotalErr < consistentTotalErr,
    `varied=${variedTotalErr.toFixed(2)} consistentOnly=${consistentTotalErr.toFixed(2)}`);
  check('pedagogy: varied wins on the large majority of seeds', variedWins >= total * 0.85,
    `${variedWins}/${total}`);
}

// 10. REQUIRED: sloppy demonstrations produce sloppy attempts (error correlation over seeds)
{
  const trueVec = [0.6, 0.4, 0.5, 0.3, 0.7];
  const noiseLevels = [0, 0.08, 0.2, 0.4];
  const SEEDS = 40;
  const avgErrByLevel = noiseLevels.map(level => {
    let total = 0;
    for (let seed = 0; seed < SEEDS; seed++) {
      const demoRng = mulberry32(9000 + seed * 13 + Math.round(level * 1000));
      const demos = [];
      for (let i = 0; i < 6; i++) {
        const noisy = trueVec.map(v => clamp01(v + (demoRng() - 0.5) * 2 * level));
        demos.push(makeDemo(noisy, 'pottery'));
      }
      const attemptRng = mulberry32(seed + 1); // identical across levels: isolates demo-noise effect
      const attempt = predictAttempt(demos, trueVec, 6, attemptRng);
      total += vectorDistance(attempt, trueVec);
    }
    return total / SEEDS;
  });
  let monotonic = true;
  for (let i = 1; i < avgErrByLevel.length; i++) if (avgErrByLevel[i] < avgErrByLevel[i - 1]) monotonic = false;
  check('sloppiness: higher demo noise -> higher (or equal) attempt error, monotonic across levels',
    monotonic, avgErrByLevel.map(v => v.toFixed(4)).join(' -> '));
  check('sloppiness: noisiest level strictly worse than noiseless level',
    avgErrByLevel[avgErrByLevel.length - 1] > avgErrByLevel[0],
    `${avgErrByLevel[avgErrByLevel.length - 1].toFixed(4)} vs ${avgErrByLevel[0].toFixed(4)}`);
}

// 11. Grader matches known shape distances
{
  check('grader: identical vectors -> 10', gradeAttempt([0.3, 0.3, 0.3, 0.3, 0.3], [0.3, 0.3, 0.3, 0.3, 0.3]) === 10);
  check('grader: maximally opposite vectors -> 0', gradeAttempt([0, 0, 0, 0, 0], [1, 1, 1, 1, 1]) === 0);
  const attempt = [1, 0, 0, 0, 0], target = [0, 0, 0, 0, 0]; // distance 1, maxDist sqrt5
  const expected = Math.round(10 * (1 - 1 / Math.sqrt(5)));
  check('grader: single-dim-off vector matches hand-computed formula',
    gradeAttempt(attempt, target) === expected, `got=${gradeAttempt(attempt, target)} expected=${expected}`);
}

// 12. demoConsistency / demoVariety on constructed sets
{
  const identical = [makeDemo([0.5, 0.5, 0.5, 0.5, 0.5], 'x'), makeDemo([0.5, 0.5, 0.5, 0.5, 0.5], 'x')];
  const spread = [makeDemo([0, 0, 0, 0, 0], 'x'), makeDemo([1, 1, 1, 1, 1], 'x')];
  check('demoConsistency: identical demos -> 1', demoConsistency(identical) === 1);
  check('demoConsistency: maximally spread demos -> 0', approx(demoConsistency(spread), 0, 1e-9));
  check('demoVariety: identical demos -> 0', demoVariety(identical) === 0);
  check('demoVariety: maximally spread demos > identical', demoVariety(spread) > demoVariety(identical));
}

// 13. generateCommission determinism
{
  const a = generateCommission(123, 4, ['pottery', 'smith']);
  const b = generateCommission(123, 4, ['pottery', 'smith']);
  check('generateCommission determinism', JSON.stringify(a) === JSON.stringify(b));
}

// 14. generateCommission bounds over >=100 (seed,index) pairs
{
  let ok = true;
  for (let seed = 0; seed < 60; seed++) {
    for (let index = 0; index < 3; index++) {
      const c = generateCommission(seed, index, ['pottery', 'smith', 'joinery']);
      for (const v of c.target) if (v < 0 || v > 1) ok = false;
      if (!['pottery', 'smith', 'joinery'].includes(c.craft)) ok = false;
    }
  }
  check('generateCommission bounds over 180 (seed,index) pairs', ok);
}

// 15. REQUIRED: graduation reachable by an optimal-teacher solver curriculum
{
  let state = newGame(555);
  let steps = 0;
  const MAX_STEPS = 15;
  while (!state.graduated && steps < MAX_STEPS) {
    const commission = generateCommission(state.seed, state.commissionIndex, state.unlockedCrafts);
    const demoVector = commission.target.slice(); // perfect demonstration
    // k=1: the freshest demo is an exact zero-distance match, so the nearest
    // neighbor is always that demo with no other neighbor diluting it.
    const out = resolveCommissionWithDemoVector(state, demoVector, 1);
    state = out.state;
    steps++;
  }
  check('graduation: optimal-teacher solver reaches graduation within 15 commissions',
    state.graduated, `reputation=${state.reputation} steps=${steps}`);
  check('graduation: every solver commission graded 10/10 (noiseless self-match)',
    state.history.every(h => h.grade === 10));
}

// 16. resolveCommission / resolveCommissionWithDemoVector determinism over an action sequence
{
  function runSeq(seed) {
    let state = newGame(seed);
    const actions = [true, false, true, true, false, true, false, true];
    for (const teach of actions) {
      const rng = mulberry32(state.commissionIndex + 1);
      const demoVec = teach ? [rng(), rng(), rng(), rng(), rng()] : null;
      state = resolveCommissionWithDemoVector(state, demoVec, 3).state;
    }
    return state;
  }
  const s1 = runSeq(42), s2 = runSeq(42);
  check('resolveCommission determinism over identical action sequence', JSON.stringify(s1) === JSON.stringify(s2));
}

// 17. Decline path with no prior demonstrations -> blind guess exactly
{
  const state = newGame(1);
  const out = resolveCommissionWithDemoVector(state, null, 3);
  check('decline with empty memory -> blind guess [0.5]*5',
    JSON.stringify(out.result.attempt) === JSON.stringify([0.5, 0.5, 0.5, 0.5, 0.5]));
  check('decline path does not add a demonstration', out.state.demonstrations.length === 0);
}

// 18. Craft unlock thresholds fire during the solver curriculum
{
  let state = newGame(777);
  let sawSmith = false, sawJoinery = false;
  for (let i = 0; i < 15 && !state.graduated; i++) {
    const commission = generateCommission(state.seed, state.commissionIndex, state.unlockedCrafts);
    const out = resolveCommissionWithDemoVector(state, commission.target.slice(), 3);
    state = out.state;
    if (state.unlockedCrafts.includes('smith')) sawSmith = true;
    if (state.unlockedCrafts.includes('joinery')) sawJoinery = true;
  }
  check('craft unlock: smith unlocks by reputation 3', sawSmith);
  check('craft unlock: joinery unlocks by reputation 6', sawJoinery);
}

// 19. shareText format
{
  let state = newGame(3);
  state = resolveCommission(state, null, 3).state; // grade will be 0 (blind guess vs real target)
  const text = shareText(state, 'journeyman');
  check('shareText contains hammer emoji and title', text.includes('JOURNEYMAN') && text.includes('\u{1F528}'));
  check('shareText contains the demonstration count', text.includes(`I taught with ${state.demonstrations.length} demonstrations`));
  check('shareText contains the live URL', text.includes('http://journeyman.defimagic.io'));
}

// 20. newGame defaults
{
  const s = newGame(9);
  check('newGame: reputation starts at 0', s.reputation === 0);
  check('newGame: pottery unlocked, others not', JSON.stringify(s.unlockedCrafts) === JSON.stringify(['pottery']));
  check('newGame: not graduated, no demonstrations, no history', !s.graduated && s.demonstrations.length === 0 && s.history.length === 0);
}

// 21. gradeAttempt defensive bounds on adversarial input
{
  check('gradeAttempt clamps below 0', gradeAttempt([5, 5, 5, 5, 5], [-5, -5, -5, -5, -5]) === 0);
}

// --- summary ---------------------------------------------------------------
console.log(`\nJOURNEYMAN tests: ${pass} passed, ${fail} failed`);
if (fail) {
  console.log('FAILURES:');
  for (const f of failures) console.log(' - ' + f);
  process.exit(1);
} else {
  process.exit(0);
}
