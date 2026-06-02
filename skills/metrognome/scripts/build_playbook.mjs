#!/usr/bin/env node
/**
 * build_playbook.mjs — distil .metrognome/ledger/*.md into a measured
 * performance lab notebook: playbook.md (human-readable) + playbook.json.
 *
 * Usage:
 *   node build_playbook.mjs <.metrognome-dir>
 *   node build_playbook.mjs --self-test
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

// ---------------------------------------------------------------------------
// Parsing

export function parseLedgerFile(content) {
  const headerMatch = content.match(/^# Experiment Ledger — (.+?) on (.+)$/im);
  if (!headerMatch) return [];
  const preset = headerMatch[1].trim();

  // direction + unit from the Metric line; both labels and values are case-tolerant
  const metricMatch = content.match(/\*\*[Mm]etric:\*\*\s*.+?\((lower|higher)-is-better,\s*unit\s*([^\s)]+)/i);
  const direction = metricMatch ? metricMatch[1] : 'lower';
  const unit = metricMatch ? metricMatch[2].replace(')', '').trim() : '';

  // split on hypothesis headings (### H1 — …)
  const blocks = content.split(/(?=###\s+H\d+\s*[—–-])/);
  const hypotheses = [];

  for (const block of blocks) {
    if (!/^###\s+H\d+/i.test(block)) continue;

    const hLine = block.match(/^###\s+H\d+\s*[—–-]\s*(.+)/im);
    const hypothesis = hLine ? hLine[1].trim() : '';

    // case-insensitive field labels; LLMs may vary capitalisation
    const guideMatch = block.match(/\*\*[Gg]uide:\*\*\s*(.+)/);
    const guide = guideMatch ? guideMatch[1].trim() : '';

    // accept KEEP / KEPT / REVERT / REVERTED, with optional trailing whitespace
    const decMatch = block.match(/\*\*[Dd]ecision:\*\*\s*(keep|kept|revert(?:ed)?)\s*$/im);
    if (!decMatch) continue;
    const decision = /^(keep|kept)$/i.test(decMatch[1]) ? 'KEEP' : 'REVERT';

    // improvement is optional — the Gate line may be reworded or absent
    const gateMatch = block.match(/\*\*[Gg]ate:\*\*\s*improvement\s*(-?[\d.]+)\s*vs\s*noise\s*band\s*([\d.]+)/i);
    const improvement = gateMatch ? parseFloat(gateMatch[1]) : null;

    hypotheses.push({ preset, direction, unit, guide, hypothesis, decision, improvement });
  }

  return hypotheses;
}

// ---------------------------------------------------------------------------
// Aggregation

export function aggregate(allHypotheses) {
  const map = new Map();
  for (const h of allHypotheses) {
    const key = `${h.preset}::${h.guide || h.hypothesis}`;
    if (!map.has(key)) {
      map.set(key, {
        preset: h.preset,
        guide: h.guide,
        hypothesis: h.hypothesis,
        direction: h.direction,
        unit: h.unit,
        kept: 0,
        tried: 0,
        effects: [],
      });
    }
    const rec = map.get(key);
    rec.tried++;
    if (h.decision === 'KEEP') {
      rec.kept++;
      if (h.improvement != null) rec.effects.push(h.improvement);
    }
    if (!rec.unit && h.unit) rec.unit = h.unit;
    if (!rec.direction && h.direction) rec.direction = h.direction;
  }
  return Array.from(map.values());
}

// ---------------------------------------------------------------------------
// Formatting

function signedEffect(value, direction) {
  return direction === 'higher' ? `+${value}` : `-${value}`;
}

function formatEffects(effects, direction, unit) {
  if (!effects.length) return 'below noise band';
  return effects.map(e => `${signedEffect(e, direction)}${unit ? ' ' + unit : ''}`).join(', ');
}

export function buildMarkdown(records, meta) {
  const wins = records.filter(r => r.kept > 0);
  const dead = records.filter(r => r.kept === 0);

  const lines = [
    '# Performance Playbook',
    '',
    '> Measured lab notebook — gated evidence from this repo\'s metrognome runs.',
    '> Read alongside `perf-memory.md` at the start of any run.',
    `> Last updated: ${meta.date} · ${meta.totalHypotheses} hypothesis run${meta.totalHypotheses !== 1 ? 's' : ''} across ${meta.ledgerCount} ledger file${meta.ledgerCount !== 1 ? 's' : ''}.`,
    '',
  ];

  if (wins.length) {
    lines.push('## Proven wins');
    lines.push('');
    lines.push('| Preset | Guide / Fix | Kept / Tried | Effects |');
    lines.push('|---|---|---|---|');
    for (const r of wins) {
      const fix = r.hypothesis || r.guide || '(unknown)';
      const label = r.guide ? `${r.guide} (${fix})` : fix;
      const fx = formatEffects(r.effects, r.direction, r.unit);
      lines.push(`| ${r.preset} | ${label} | ${r.kept}/${r.tried} | ${fx} |`);
    }
    lines.push('');
  }

  if (dead.length) {
    lines.push('## Dead ends (did not clear gate — do not retry)');
    lines.push('');
    lines.push('| Preset | Guide / Fix | Tried | Note |');
    lines.push('|---|---|---|---|');
    for (const r of dead) {
      const fix = r.hypothesis || r.guide || '(unknown)';
      const label = r.guide ? `${r.guide} (${fix})` : fix;
      lines.push(`| ${r.preset} | ${label} | ${r.tried} | below noise band |`);
    }
    lines.push('');
  }

  if (!wins.length && !dead.length) {
    lines.push('_No completed ledger entries yet — run a preset to populate._');
    lines.push('');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Run

function run(dotMetrognomeDir) {
  const ledgerDir = path.join(dotMetrognomeDir, 'ledger');
  let ledgerFiles = [];
  if (fs.existsSync(ledgerDir)) {
    ledgerFiles = fs.readdirSync(ledgerDir).filter(f => f.endsWith('.md'));
  }

  const allHypotheses = [];
  for (const f of ledgerFiles) {
    try {
      const content = fs.readFileSync(path.join(ledgerDir, f), 'utf8');
      allHypotheses.push(...parseLedgerFile(content));
    } catch (_) { /* skip unreadable files */ }
  }

  const records = aggregate(allHypotheses);
  const meta = {
    date: new Date().toISOString().slice(0, 10),
    totalHypotheses: allHypotheses.length,
    ledgerCount: ledgerFiles.length,
  };

  const md = buildMarkdown(records, meta);
  const json = JSON.stringify({ generatedAt: new Date().toISOString(), meta, records }, null, 2);

  const mdOut = path.join(dotMetrognomeDir, 'playbook.md');
  const jsonOut = path.join(dotMetrognomeDir, 'playbook.json');
  fs.writeFileSync(mdOut, md, 'utf8');
  fs.writeFileSync(jsonOut, json, 'utf8');

  const nWins = records.filter(r => r.kept > 0).length;
  const nDead = records.filter(r => r.kept === 0).length;
  console.log('metrognome playbook');
  console.log(`  wrote ${path.resolve(mdOut)}`);
  console.log(`  wrote ${path.resolve(jsonOut)}`);
  console.log(`  ${nWins} proven win${nWins !== 1 ? 's' : ''}, ${nDead} dead end${nDead !== 1 ? 's' : ''} · ${allHypotheses.length} hypothesis run${allHypotheses.length !== 1 ? 's' : ''}`);
}

// ---------------------------------------------------------------------------
// Self-test (runs in-memory; never touches disk)

function selfTest() {
  let pass = 0, fail = 0;
  const ok = (name, got, want) => {
    const equal = JSON.stringify(got) === JSON.stringify(want);
    console.log(`  ${equal ? 'PASS' : 'FAIL'}  ${name}  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`);
    equal ? pass++ : fail++;
  };

  // L1: tidy ledger, listing KEEP
  const L1 = `# Experiment Ledger — listing on FeedScreen

- **Run:** 2026-05-30T10:00:00Z
- **Metric:** jank (lower-is-better, unit ms)

## Baseline
- runs: 1200,1180,1210,1190,1205
- mean ± stddev: 1197 ± 11.2

### H1 — getItemLayout missing on FlatList
- **Guide:** js/optimizing-flatlist
- **Change (atomic):** Added getItemLayout  (screens/FeedScreen.tsx)
- **Candidate runs:** 980,990,985,975,990
- **mean ± stddev:** 984 ± 5.7
- **Gate:** improvement 213 vs noise band 24 (max of min_effect 30, k·pooled_std 24)
- **Decision:** KEEP
- **Commit / revert:** abc1234
`;

  // L2: second KEEP for same guide
  const L2 = `# Experiment Ledger — listing on FeedScreen

- **Run:** 2026-05-31T14:00:00Z
- **Metric:** jank (lower-is-better, unit ms)

## Baseline
- runs: 984,990,982,978,986
- mean ± stddev: 984 ± 4.3

### H1 — getItemLayout missing on FlatList
- **Guide:** js/optimizing-flatlist
- **Change (atomic):** Added getItemLayout  (screens/FeedScreen.tsx)
- **Candidate runs:** 810,820,815,812,818
- **mean ± stddev:** 815 ± 3.9
- **Gate:** improvement 169 vs noise band 20
- **Decision:** KEEP
- **Commit / revert:** def5678
`;

  // L3: REVERT for re-renders
  const L3 = `# Experiment Ledger — re-renders on ChatScreen

- **Run:** 2026-06-01T09:00:00Z
- **Metric:** re-renders (lower-is-better, unit commits)

## Baseline
- runs: 24,25,24,26,25
- mean ± stddev: 24.8 ± 0.75

### H1 — inline-prop hoist
- **Guide:** js/hoist-inline-props
- **Change (atomic):** Extract inline styles  (screens/ChatScreen.tsx)
- **Candidate runs:** 24,25,23,25,24
- **mean ± stddev:** 24.2 ± 0.75
- **Gate:** improvement 0.6 vs noise band 5
- **Decision:** REVERT
- **Commit / revert:** reverted
`;

  // L4: messy — lowercase labels, KEPT, no gate line (LLM drift)
  const L4 = `# Experiment Ledger — re-renders on FeedScreen

- **Run:** 2026-06-02T09:00:00Z
- **metric:** re-renders (lower-is-better, unit commits)

## Baseline
- runs: 30,29,31,30,28
- mean ± stddev: 29.6 ± 1.0

### H1 — React.memo row component
- **guide:** js/memo-components
- **Change (atomic):** Wrap Row in React.memo  (components/Row.tsx)
- **Candidate runs:** 20,21,19,20,21
- **mean ± stddev:** 20.2 ± 0.75
- **Decision:**   KEPT
- **Commit / revert:** ghi9012
`;

  // Parsing — tidy ledger
  const h1 = parseLedgerFile(L1);
  ok('L1 yields 1 hypothesis', h1.length, 1);
  ok('L1 preset', h1[0]?.preset, 'listing');
  ok('L1 guide', h1[0]?.guide, 'js/optimizing-flatlist');
  ok('L1 decision', h1[0]?.decision, 'KEEP');
  ok('L1 improvement', h1[0]?.improvement, 213);
  ok('L1 unit', h1[0]?.unit, 'ms');
  ok('L1 direction', h1[0]?.direction, 'lower');

  // Parsing — messy ledger
  const h4 = parseLedgerFile(L4);
  ok('L4 yields 1 hypothesis (case-insensitive labels)', h4.length, 1);
  ok('L4 KEPT normalises to KEEP', h4[0]?.decision, 'KEEP');
  ok('L4 guide (lowercase label)', h4[0]?.guide, 'js/memo-components');
  ok('L4 improvement null (no gate line)', h4[0]?.improvement, null);

  // Parsing — REVERT
  const h3 = parseLedgerFile(L3);
  ok('L3 decision is REVERT', h3[0]?.decision, 'REVERT');

  // Aggregation
  const all = [...h1, ...parseLedgerFile(L2), ...h3, ...h4];
  const records = aggregate(all);
  ok('3 distinct records', records.length, 3);

  const fl = records.find(r => r.guide === 'js/optimizing-flatlist');
  ok('flatlist kept/tried 2/2', `${fl?.kept}/${fl?.tried}`, '2/2');
  ok('flatlist has 2 effect values', fl?.effects?.length, 2);

  const hoist = records.find(r => r.guide === 'js/hoist-inline-props');
  ok('hoist kept/tried 0/1', `${hoist?.kept}/${hoist?.tried}`, '0/1');

  const memo = records.find(r => r.guide === 'js/memo-components');
  ok('memo kept/tried 1/1', `${memo?.kept}/${memo?.tried}`, '1/1');
  ok('memo no improvement value → empty effects', memo?.effects?.length, 0);

  // Markdown output
  const md = buildMarkdown(records, { date: '2026-06-06', totalHypotheses: 4, ledgerCount: 4 });
  ok('md contains proven wins section', md.includes('## Proven wins'), true);
  ok('md contains dead ends section', md.includes('## Dead ends'), true);
  ok('md shows 2/2 tally', md.includes('2/2'), true);
  ok('md uses correct lower-is-better sign (-)', md.includes('-213 ms'), true);
  ok('md does not show empty-state message', !md.includes('No completed ledger'), true);

  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

// ---------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) return selfTest();

  const dir = args.find(a => !a.startsWith('--'));
  if (!dir) {
    console.error('usage: node build_playbook.mjs <.metrognome-dir>');
    console.error('       node build_playbook.mjs --self-test');
    process.exit(1);
  }
  if (!fs.existsSync(dir)) {
    console.error(`directory not found: ${dir}`);
    process.exit(1);
  }
  run(dir);
}

main();
