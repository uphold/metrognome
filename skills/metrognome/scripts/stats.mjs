#!/usr/bin/env node
/**
 * stats.mjs — measurement statistics + the keep/revert gate.
 *
 * The whole point of metrognome's loop is to never record an unmeasured win.
 * A single before/after sample lies: device perf is noisy (thermals, GC,
 * background work), so a 3% "improvement" is usually noise. This module turns
 * two N-run distributions into an honest keep/revert decision:
 *
 *   improvement clears the gate  <=>  delta > max(minEffect, k * pooledStdDev)
 *
 * i.e. the change must beat BOTH an absolute floor (minEffect — don't chase
 * changes too small to matter) AND the measurement noise (k pooled std devs,
 * k≈2). Otherwise we can't distinguish it from jitter, so we revert.
 *
 * Usage:
 *   node stats.mjs --baseline "1200,1180,1210" --candidate "980,1000,990" \
 *        [--min-effect 50] [--k 2] [--direction lower|higher] [--unit ms]
 *   node stats.mjs --self-test
 */

import process from 'node:process';

export const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;

export function stdDev(a) {
  if (a.length < 2) return 0;
  const m = mean(a);
  const v = a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1); // sample variance
  return Math.sqrt(v);
}

export function pooledStdDev(a, b) {
  const na = a.length, nb = b.length;
  if (na + nb - 2 <= 0) return Math.max(stdDev(a), stdDev(b));
  const va = stdDev(a) ** 2, vb = stdDev(b) ** 2;
  return Math.sqrt(((na - 1) * va + (nb - 1) * vb) / (na + nb - 2));
}

/**
 * Decide whether `candidate` is a real improvement over `baseline`.
 * direction: 'lower' (default) for TTI/jank/RAM/bytes/commits where smaller is
 * better; 'higher' for FPS where bigger is better.
 */
export function gate({ baseline, candidate, minEffect = 0, k = 2, direction = 'lower' }) {
  const baseMean = mean(baseline);
  const candMean = mean(candidate);
  const improvement = direction === 'higher' ? candMean - baseMean : baseMean - candMean;
  const pooled = pooledStdDev(baseline, candidate);
  const noiseBand = Math.max(minEffect, k * pooled);
  const keep = improvement > noiseBand;
  return {
    baseline: { mean: round(baseMean), std: round(stdDev(baseline)), n: baseline.length },
    candidate: { mean: round(candMean), std: round(stdDev(candidate)), n: candidate.length },
    direction,
    improvement: round(improvement),
    improvementPct: baseMean ? round((improvement / baseMean) * 100) : 0,
    pooledStd: round(pooled),
    k,
    minEffect,
    noiseBand: round(noiseBand),
    decision: keep ? 'KEEP' : 'REVERT',
    reason: keep
      ? `improvement ${round(improvement)} > noise band ${round(noiseBand)} (max of minEffect ${minEffect}, ${k}x pooled std ${round(pooled)})`
      : `improvement ${round(improvement)} did not clear noise band ${round(noiseBand)} — indistinguishable from jitter, revert`,
  };
}

const round = (x) => Math.round(x * 100) / 100;
const parseList = (s) => String(s).split(',').map((x) => parseFloat(x.trim())).filter((x) => !Number.isNaN(x));

// ---------------------------------------------------------------------------
function selfTest() {
  let pass = 0, fail = 0;
  const check = (name, got, want) => {
    const ok = got === want;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}  (got ${got}, want ${want})`);
    ok ? pass++ : fail++;
  };

  // 1. Clear win beyond noise -> KEEP
  check('clear TTI win', gate({
    baseline: [1200, 1180, 1210, 1190, 1205], candidate: [980, 1000, 990, 1010, 995], minEffect: 30,
  }).decision, 'KEEP');

  // 2. Within noise -> REVERT
  check('noise-level change', gate({
    baseline: [1000, 1050, 950, 1020, 980], candidate: [990, 1040, 960, 1010, 1000], minEffect: 20,
  }).decision, 'REVERT');

  // 3. Regression (candidate worse) -> REVERT
  check('regression', gate({
    baseline: [1000, 1010, 990, 1005, 995], candidate: [1100, 1120, 1090, 1110, 1095], minEffect: 20,
  }).decision, 'REVERT');

  // 4. FPS higher-is-better win -> KEEP
  check('fps win (higher better)', gate({
    baseline: [45, 46, 44, 45, 46], candidate: [58, 59, 57, 60, 58], direction: 'higher', minEffect: 2,
  }).decision, 'KEEP');

  // 5. Tiny but consistent improvement below minEffect floor -> REVERT
  check('below min-effect floor', gate({
    baseline: [1000, 1000, 1000, 1000], candidate: [995, 995, 995, 995], minEffect: 50,
  }).decision, 'REVERT');

  // 6. mean / stdDev sanity
  check('mean', mean([2, 4, 6]), 4);
  check('stdDev of constant is 0', stdDev([5, 5, 5]), 0);

  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) return selfTest();

  const get = (flag, def) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : def; };
  const baseline = parseList(get('--baseline', ''));
  const candidate = parseList(get('--candidate', ''));
  if (!baseline.length || !candidate.length) {
    console.error('usage: node stats.mjs --baseline "a,b,c" --candidate "x,y,z" [--min-effect N] [--k 2] [--direction lower|higher] [--unit ms]');
    console.error('       node stats.mjs --self-test');
    process.exit(1);
  }
  const result = gate({
    baseline, candidate,
    minEffect: parseFloat(get('--min-effect', '0')) || 0,
    k: parseFloat(get('--k', '2')) || 2,
    direction: get('--direction', 'lower'),
  });
  const unit = get('--unit', '');
  console.log(JSON.stringify({ ...result, unit }, null, 2));
}

main();
