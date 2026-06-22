#!/usr/bin/env node
/**
 * perf_scan.mjs — static React Native perf-debt scanner.
 *
 * Walks a RN repo, parses every JS/TS(X) source with Babel, runs a set of
 * anti-pattern detectors, and emits graph.json: a module dependency graph
 * where each node carries a perf-debt score and the findings behind it.
 *
 * Design notes:
 *  - Nodes = source modules (files). Edges = static import relationships.
 *    Module-level nodes + the import graph are robust to compute and read
 *    cleanly; render-parent graphs are unreliable across files so we don't
 *    pretend to draw them.
 *  - The make-or-break property of this tool is signal-vs-noise. RN static
 *    heuristics (inline arrow props, missing memo) fire constantly in real
 *    code and are mostly harmless. So we score, then GATE: only nodes whose
 *    debt clears HOTSPOT_DEBT are colored/enlarged; everything else stays
 *    small and grey with its low-severity findings tucked into the tooltip.
 *  - Every tuning knob lives in CONFIG below. Tune there against a real OSS
 *    repo, never against the seeded fixture (the fixture is circular).
 *
 * Usage:
 *   node perf_scan.mjs <repo-or-src-path> [--out graph.json] [--quiet]
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';

// Babel packages are CJS — load via createRequire (same pattern as doctor.mjs)
// so a missing install fails with one actionable line instead of a raw
// ERR_MODULE_NOT_FOUND stack (the SessionStart hook's npm install is silent
// by design, so this is the user's first signal).
const requireLocal = createRequire(import.meta.url);
let parse, traverse;
try {
  ({ parse } = requireLocal('@babel/parser'));
  const _traverse = requireLocal('@babel/traverse');
  traverse = _traverse.default || _traverse;
} catch {
  console.error(`[metrognome] missing deps (@babel/parser, @babel/traverse) — run: npm install in ${path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..')}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// CONFIG — the single place to tune signal-vs-noise. See perf-map.md.
// ---------------------------------------------------------------------------
const CONFIG = {
  // Severity -> raw debt weight. MEDIUM/LOW are deliberately small so the
  // common-but-harmless detectors can't drown the structural ones.
  severityWeight: { CRITICAL: 10, HIGH: 5, MEDIUM: 1.5, LOW: 0.4 },

  // debt = rawSeverity * (1 + centralityK*log2(1+fanIn) + (hasList ? listBonus : 0))
  // Central modules (imported widely) and list screens amplify their debt — a
  // flaw in a shared hub matters more than in a leaf. The amplification is
  // LOGARITHMIC: on a real repo a navigation hub can have fan-in in the
  // hundreds, and a linear multiplier lets one such file dwarf everything
  // (debt 262 vs 44 on bluesky). log2 saturates it to a sane ~2-3x.
  centralityK: 0.25,
  listBonus: 0.5,

  // Diminishing returns: the Nth identical finding in one file carries far
  // less signal than the first (a config file with 150 inline `options={{}}`
  // props is not 150x worse than one with 2). Past this many of the SAME
  // detector in a file, extra instances add only log2 weight. This is what
  // stops idiomatic-but-noisy patterns from manufacturing fake hotspots,
  // while leaving rare structural findings (a leak, a missing getItemLayout)
  // at full weight.
  diminishAfter: 3,

  // Gating combines two rules (see isHotspot below):
  //   1. debt >= hotspotDebt  — for MEDIUM/LOW findings that only matter once
  //      they accumulate (a cluster of un-memoized rows, many barrels).
  //   2. any HIGH/CRITICAL finding — structurally important even in a leaf
  //      file (a memory leak, a list missing getItemLayout), so it's ALWAYS a
  //      hotspot regardless of debt.
  // Below both, a node renders small + grey with findings only on hover.
  // Tuned on bluesky (1465 files): this yields ~20 legible hotspots, not 173.
  hotspotDebt: 6,

  // Perf Map renders only nodes with debt >= this (live-adjustable in the HTML).
  // Default chosen to drop the zero/near-zero-finding cold cloud without hiding
  // structural debt. Not a hotspot-gate knob — that's hotspotDebt above. Tune
  // in-page via the min-debt control, not here.
  displayMinDebt: 2,

  // Node sizing for the 3D map. Hotspots are deliberately much larger than the
  // cold cloud so they pop even when a large repo (1000+ modules) is in view.
  sizeBaseHot: 6,
  sizeK: 1.3,
  sizeMax: 60,
  sizeCold: 0.8,

  // Files/dirs never scanned.
  ignoreDirs: new Set([
    'node_modules', '.git', 'ios', 'android', 'build', 'dist', '.expo',
    '.next', 'coverage', '__snapshots__', '__mocks__', 'vendor', 'Pods',
  ]),
  // Test/spec/story files are excluded — they aren't shipped perf surface.
  ignoreFileRe: /(\.test\.|\.spec\.|\.stories\.|\.d\.ts$)/,
  exts: ['.tsx', '.ts', '.jsx', '.js', '.mjs', '.cjs'],

  // D7: full-package imports of these at an app-entry file are HIGH cost.
  heavyLibs: new Set([
    'moment', 'lodash', 'rxjs', 'core-js', 'react-native-vector-icons',
    'jsbarcode', 'crypto-js', 'highlight.js',
  ]),
  entryFileRe: /(^|\/)(App|app|index|_layout)\.(t|j)sx?$/,

  // D9 thresholds.
  initialNumToRenderMax: 20,
};

// Severity ordering for "max severity" of a node.
const SEV_RANK = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1 };
const SEV_COLOR = {
  CRITICAL: '#ff3b3b',
  HIGH: '#ff9f1c',
  MEDIUM: '#ffd23f',
  LOW: '#7f8c9b',
};
const COLD_COLOR = '#586480'; // visible-but-muted grey-blue for below-gate nodes

// Detector catalog: id -> { preset, guide, severity, title }.
// `guide` is the react-native-best-practices reference to consult; see
// references/presets.md for the exact mapping kept in sync with Callstack.
const DETECTORS = {
  listNoItemLayout: { preset: 'listing', guide: 'js/optimizing-flatlist', severity: 'HIGH',
    title: 'FlatList/SectionList without getItemLayout' },
  indexAsKey: { preset: 'listing', guide: 'js/optimizing-flatlist', severity: 'HIGH',
    title: 'List uses array index as key' },
  nestedComponent: { preset: 're-renders', guide: 'js/avoid-anonymous-functions', severity: 'HIGH',
    title: 'Component defined inside another component' },
  inlinePropLiteral: { preset: 're-renders', guide: 'js/avoid-anonymous-functions', severity: 'LOW',
    title: 'Inline function/object/style literal as prop' },
  listRowNoMemo: { preset: 're-renders', guide: 'js/memoization', severity: 'MEDIUM',
    title: 'List row component not wrapped in React.memo' },
  effectNoCleanup: { preset: 'memory-leaks', guide: 'js/cleanup-effects', severity: 'HIGH',
    title: 'useEffect subscription/timer with no cleanup' },
  barrelImport: { preset: 'bundle-size', guide: 'bundling/avoid-barrel-files', severity: 'LOW',
    title: 'Barrel re-export import' },
  heavyEntryImport: { preset: 'first-load', guide: 'bundling/lazy-loading', severity: 'HIGH',
    title: 'Heavy synchronous import at app entry' },
  imageNoDims: { preset: 'first-load', guide: 'native/image-optimization', severity: 'LOW',
    title: 'Image without explicit dimensions' },
  oversizedList: { preset: 'listing', guide: 'js/optimizing-flatlist', severity: 'LOW',
    title: 'Oversized initialNumToRender / no removeClippedSubviews' },
};

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------
function walk(root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { continue; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!CONFIG.ignoreDirs.has(e.name) && !e.name.startsWith('.')) stack.push(full);
      } else if (e.isFile()) {
        const ext = path.extname(e.name);
        if (CONFIG.exts.includes(ext) && !CONFIG.ignoreFileRe.test(e.name)) out.push(full);
      }
    }
  }
  return out;
}

// Path-alias map (e.g. "#/*" -> "<repo>/src/*"), loaded from tsconfig/jsconfig.
// Real RN apps import almost everything through aliases, not "../". Without
// resolving them the dependency graph is a disconnected cloud and centrality
// (import fan-in) is meaningless — so this is correctness, not cosmetics.
let ALIASES = [];

function stripJsonComments(s) {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/,(\s*[}\]])/g, '$1');
}

function loadAliases(startDir) {
  let dir = path.resolve(startDir);
  try { if (fs.existsSync(dir) && !fs.statSync(dir).isDirectory()) dir = path.dirname(dir); } catch {}
  for (let i = 0; i < 8; i++) {
    for (const name of ['tsconfig.json', 'jsconfig.json']) {
      const cfg = path.join(dir, name);
      if (!fs.existsSync(cfg)) continue;
      try {
        const json = JSON.parse(stripJsonComments(fs.readFileSync(cfg, 'utf8')));
        const co = json.compilerOptions || {};
        if (!co.paths) continue;
        const baseUrl = path.resolve(dir, co.baseUrl || '.');
        const out = [];
        for (const [pat, targets] of Object.entries(co.paths)) {
          const tgt = Array.isArray(targets) ? targets[0] : null;
          if (!tgt) continue;
          if (pat.endsWith('/*') && tgt.endsWith('/*')) {
            out.push({ prefix: pat.slice(0, -1), base: path.resolve(baseUrl, tgt.slice(0, -1)) });
          } else {
            out.push({ exact: pat, file: path.resolve(baseUrl, tgt) });
          }
        }
        if (out.length) return out;
      } catch { /* tolerant: ignore unparseable config */ }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return [];
}

function tryResolveFile(base) {
  // base is an extensionless (or extensioned) absolute path; resolve to a real
  // file, falling back to a directory's index.* (the barrel-file pattern).
  if (CONFIG.exts.includes(path.extname(base)) && fs.existsSync(base)) {
    return { file: base, isBarrel: false };
  }
  for (const ext of CONFIG.exts) {
    const cand = base + ext;
    if (fs.existsSync(cand)) return { file: cand, isBarrel: false };
  }
  try {
    if (fs.existsSync(base) && fs.statSync(base).isDirectory()) {
      for (const ext of CONFIG.exts) {
        const cand = path.join(base, 'index' + ext);
        if (fs.existsSync(cand)) return { file: cand, isBarrel: true };
      }
    }
  } catch { /* ignore */ }
  return { file: null, isBarrel: false };
}

function resolveImport(fromFile, spec) {
  // Returns { file: absolutePath|null, isBarrel: bool }.
  if (spec.startsWith('.')) {
    return tryResolveFile(path.resolve(path.dirname(fromFile), spec));
  }
  for (const a of ALIASES) {
    if (a.exact && spec === a.exact) return tryResolveFile(a.file);
    if (a.prefix && spec.startsWith(a.prefix)) {
      return tryResolveFile(path.join(a.base, spec.slice(a.prefix.length)));
    }
  }
  return { file: null, isBarrel: false };
}

// ---------------------------------------------------------------------------
// AST helpers
// ---------------------------------------------------------------------------
const isPascal = (name) => typeof name === 'string' && /^[A-Z]/.test(name);

function functionContainsOwnJSX(fnPath) {
  let found = false;
  fnPath.traverse({
    'JSXElement|JSXFragment'(p) {
      if (found) return;
      if (p.getFunctionParent() === fnPath) { found = true; p.stop(); }
    },
  });
  return found;
}

function isComponentFunction(fnPath, name) {
  return isPascal(name) && functionContainsOwnJSX(fnPath);
}

// Is this JSX usage inside a list-rendering context (a .map callback or a
// renderItem-style prop)? That's what makes a missing memo actually matter.
function insideListContext(jsxPath) {
  return !!jsxPath.findParent((p) => {
    if (p.isCallExpression()) {
      const callee = p.node.callee;
      if (callee && callee.type === 'MemberExpression' &&
          callee.property && callee.property.name === 'map') return true;
    }
    if (p.isJSXAttribute && p.isJSXAttribute()) {
      const n = p.node.name && p.node.name.name;
      if (n === 'renderItem' || n === 'ListHeaderComponent' || n === 'ListFooterComponent') return true;
    }
    return false;
  });
}

// ---------------------------------------------------------------------------
// Per-file analysis
// ---------------------------------------------------------------------------
function analyzeFile(absFile, code, repoRoot) {
  const rel = path.relative(repoRoot, absFile);
  const findings = [];
  const imports = [];
  const add = (id, line, detail) => {
    const d = DETECTORS[id];
    findings.push({ id, severity: d.severity, preset: d.preset, guide: d.guide,
      title: d.title, line: line || 0, detail: detail || '' });
  };

  let ast;
  try {
    ast = parse(code, {
      sourceType: 'unambiguous',
      allowReturnOutsideFunction: true,
      errorRecovery: true,
      plugins: [
        'jsx', 'typescript', 'classProperties', 'decorators-legacy',
        'objectRestSpread', 'optionalChaining', 'nullishCoalescingOperator',
        'topLevelAwait', 'dynamicImport',
      ],
    });
  } catch {
    return { rel, absFile, findings, imports, hasList: false, isBarrelFile: false, parseError: true };
  }

  const isEntry = CONFIG.entryFileRe.test(rel);
  const localComponents = new Set();
  const memoized = new Set();
  let hasList = false;
  let reExportAll = 0;
  let reExportNamed = 0;
  const listRowFlagged = new Set();

  // Pass 1: collect local component definitions + memo status.
  traverse(ast, {
    VariableDeclarator(p) {
      const id = p.node.id;
      if (!id || id.type !== 'Identifier' || !isPascal(id.name)) return;
      const init = p.node.init;
      if (!init) return;
      if (init.type === 'CallExpression') {
        const c = init.callee;
        const callName = c && (c.name || (c.property && c.property.name));
        if (callName === 'memo' || callName === 'forwardRef') {
          localComponents.add(id.name); memoized.add(id.name); return;
        }
      }
      if (init.type === 'ArrowFunctionExpression' || init.type === 'FunctionExpression') {
        const fnPath = p.get('init');
        if (functionContainsOwnJSX(fnPath)) localComponents.add(id.name);
      }
    },
    FunctionDeclaration(p) {
      const name = p.node.id && p.node.id.name;
      if (isPascal(name) && functionContainsOwnJSX(p)) localComponents.add(name);
    },
  });

  // Pass 2: detectors.
  traverse(ast, {
    ImportDeclaration(p) {
      const spec = p.node.source.value;
      const { file } = resolveImport(absFile, spec);
      const hasNamed = p.node.specifiers.some((s) => s.type === 'ImportSpecifier');
      // barrelImport is decided later, once we know which target files are
      // actual re-export barrels (an import resolving to Dialog/index.tsx is
      // fine; one resolving to a components/index.ts re-export hub is not).
      if (file) imports.push({ file, line: p.node.loc?.start.line || 0, spec, hasNamed });
      // D7 heavy entry import: full-package import (no deep path) of a heavy lib.
      const isFullPkg = !spec.startsWith('.') && !spec.includes('/');
      if (isEntry && isFullPkg && CONFIG.heavyLibs.has(spec)) {
        add('heavyEntryImport', p.node.loc?.start.line, spec);
      }
    },

    // Re-export tallies identify whether THIS file is itself a barrel.
    ExportAllDeclaration() { reExportAll++; },
    ExportNamedDeclaration(p) { if (p.node.source) reExportNamed++; },

    // D2: named component defined inside another component.
    'FunctionDeclaration|ArrowFunctionExpression|FunctionExpression'(p) {
      let name = null;
      if (p.isFunctionDeclaration()) name = p.node.id && p.node.id.name;
      else if (p.parentPath.isVariableDeclarator()) {
        const idn = p.parentPath.node.id;
        name = idn && idn.type === 'Identifier' ? idn.name : null;
      }
      if (!isComponentFunction(p, name)) return;
      const parentFn = p.getFunctionParent();
      if (parentFn) {
        // parent must itself look like a component for this to be the
        // "component-in-component" smell (vs a helper inside a module).
        let parentName = null;
        if (parentFn.isFunctionDeclaration()) parentName = parentFn.node.id && parentFn.node.id.name;
        else if (parentFn.parentPath && parentFn.parentPath.isVariableDeclarator()) {
          const idn = parentFn.parentPath.node.id;
          parentName = idn && idn.type === 'Identifier' ? idn.name : null;
        }
        if (isComponentFunction(parentFn, parentName)) {
          add('nestedComponent', p.node.loc?.start.line, name);
        }
      }
    },

    JSXAttribute(p) {
      const valNode = p.node.value;
      if (!valNode || valNode.type !== 'JSXExpressionContainer') return;
      const expr = valNode.expression;
      const attrName = p.node.name && p.node.name.name;
      // D3: inline arrow/object/style literal as a prop in render.
      if (expr && (expr.type === 'ArrowFunctionExpression' ||
                   expr.type === 'FunctionExpression' ||
                   expr.type === 'ObjectExpression')) {
        // Don't double-count renderItem here; it's the idiomatic FlatList API.
        if (attrName !== 'renderItem' && attrName !== 'keyExtractor') {
          add('inlinePropLiteral', p.node.loc?.start.line, attrName);
        }
      }
      // D1b: index-as-key via keyExtractor={(item, index) => index} or key={index}
      if ((attrName === 'keyExtractor' || attrName === 'key') &&
          expr && (expr.type === 'ArrowFunctionExpression' || expr.type === 'FunctionExpression')) {
        const params = expr.params || [];
        const idxParam = params[1] && params[1].name;
        const body = expr.body;
        if (idxParam && body && body.type === 'Identifier' && body.name === idxParam) {
          add('indexAsKey', p.node.loc?.start.line, attrName);
        }
      }
    },

    JSXOpeningElement(p) {
      const nameNode = p.node.name;
      const tag = nameNode && (nameNode.name ||
        (nameNode.type === 'JSXMemberExpression' && nameNode.property && nameNode.property.name));
      if (!tag) return;
      const attrs = p.node.attributes.filter((a) => a.type === 'JSXAttribute');
      const attrNames = new Set(attrs.map((a) => a.name && a.name.name));

      if (tag === 'FlatList' || tag === 'SectionList' || tag === 'FlashList') {
        hasList = true;
        if (tag !== 'FlashList' && !attrNames.has('getItemLayout')) {
          add('listNoItemLayout', p.node.loc?.start.line, tag);
        }
        // D1b: key={index} inside keyExtractor handled in JSXAttribute.
        // D1c: index-as-key shorthand keyExtractor={(_, i) => `${i}`} skipped (low value, noisy).
        // D9: oversized initialNumToRender / missing removeClippedSubviews.
        const initAttr = attrs.find((a) => a.name && a.name.name === 'initialNumToRender');
        let oversized = false;
        if (initAttr && initAttr.value && initAttr.value.type === 'JSXExpressionContainer' &&
            initAttr.value.expression.type === 'NumericLiteral' &&
            initAttr.value.expression.value > CONFIG.initialNumToRenderMax) oversized = true;
        if (oversized || (tag !== 'FlashList' && !attrNames.has('removeClippedSubviews'))) {
          add('oversizedList', p.node.loc?.start.line, tag);
        }
      }

      // D8: <Image source={{uri}} /> with no width/height.
      if (tag === 'Image' || tag === 'ImageBackground') {
        const styleAttr = attrs.find((a) => a.name && a.name.name === 'style');
        const hasW = attrs.some((a) => a.name && (a.name.name === 'width' || a.name.name === 'height'));
        let dimInStyle = false;
        if (styleAttr && styleAttr.value && styleAttr.value.type === 'JSXExpressionContainer') {
          const src = code.slice(styleAttr.value.start, styleAttr.value.end);
          dimInStyle = /width|height/.test(src);
        }
        const srcAttr = attrs.find((a) => a.name && a.name.name === 'source');
        const isRemote = srcAttr && srcAttr.value && srcAttr.value.type === 'JSXExpressionContainer' &&
          /uri\s*:/.test(code.slice(srcAttr.value.start, srcAttr.value.end));
        if (isRemote && !hasW && !dimInStyle) add('imageNoDims', p.node.loc?.start.line, tag);
      }

      // D4: list-row component used in a list context but not memoized.
      if (isPascal(tag) && localComponents.has(tag) && !memoized.has(tag) && !listRowFlagged.has(tag)) {
        if (insideListContext(p)) {
          listRowFlagged.add(tag);
          add('listRowNoMemo', p.node.loc?.start.line, tag);
        }
      }
    },

    // D5: useEffect with subscription/timer and no cleanup return.
    CallExpression(p) {
      const callee = p.node.callee;
      const name = callee && (callee.name || (callee.property && callee.property.name));
      if (name !== 'useEffect') return;
      const cb = p.node.arguments[0];
      if (!cb || (cb.type !== 'ArrowFunctionExpression' && cb.type !== 'FunctionExpression')) return;
      const cbPath = p.get('arguments.0');
      let subscribes = false;
      let returnsCleanup = false;
      cbPath.traverse({
        CallExpression(c) {
          const cn = c.node.callee;
          const m = cn && (cn.name || (cn.property && cn.property.name));
          if (['addEventListener', 'addListener', 'setInterval', 'setTimeout',
               'subscribe', 'on', 'addObserver'].includes(m)) subscribes = true;
        },
        ReturnStatement(r) {
          if (r.getFunctionParent() === cbPath && r.node.argument &&
              (r.node.argument.type === 'ArrowFunctionExpression' ||
               r.node.argument.type === 'FunctionExpression' ||
               r.node.argument.type === 'Identifier')) returnsCleanup = true;
        },
      });
      if (subscribes && !returnsCleanup) add('effectNoCleanup', p.node.loc?.start.line);
    },
  });

  // A re-export barrel: `export * from` anywhere, or several `export { } from`
  // statements. Importing named symbols through such a file pulls the whole
  // barrel into the bundle and defeats tree-shaking.
  const isBarrelFile = reExportAll > 0 || reExportNamed >= 3;
  return { rel, absFile, findings, imports, hasList, isBarrelFile, parseError: false };
}

// ---------------------------------------------------------------------------
// Graph assembly + scoring
// ---------------------------------------------------------------------------
function build(repoRoot, files) {
  const analyses = [];
  for (const f of files) {
    let code;
    try { code = fs.readFileSync(f, 'utf8'); } catch { continue; }
    analyses.push(analyzeFile(f, code, repoRoot));
  }

  const byAbs = new Map(analyses.map((a) => [a.absFile, a]));

  // Barrel cross-reference: now that every file knows whether IT is a re-export
  // barrel, flag the import SITES that pull named symbols through one.
  const barrelSet = new Set(analyses.filter((a) => a.isBarrelFile).map((a) => a.absFile));
  for (const a of analyses) {
    const seen = new Set();
    for (const imp of a.imports) {
      if (!imp.hasNamed || !barrelSet.has(imp.file) || seen.has(imp.file)) continue;
      seen.add(imp.file);
      const d = DETECTORS.barrelImport;
      a.findings.push({ id: 'barrelImport', severity: d.severity, preset: d.preset,
        guide: d.guide, title: d.title, line: imp.line, detail: imp.spec });
    }
  }

  const fanIn = new Map();
  const links = [];
  const seenLink = new Set();
  for (const a of analyses) {
    for (const imp of a.imports) {
      const tgt = imp.file;
      if (!byAbs.has(tgt) || tgt === a.absFile) continue;
      const tRel = byAbs.get(tgt).rel;
      fanIn.set(tRel, (fanIn.get(tRel) || 0) + 1);
      const key = a.rel + '->' + tRel;
      if (!seenLink.has(key)) { seenLink.add(key); links.push({ source: a.rel, target: tRel }); }
    }
  }

  const diminish = (count) => count <= CONFIG.diminishAfter
    ? count
    : CONFIG.diminishAfter + Math.log2(count - CONFIG.diminishAfter + 1);

  const nodes = analyses.map((a) => {
    // Sum per-detector with diminishing returns so a long tail of one noisy
    // pattern can't dominate; distinct detectors still stack normally.
    // Split STRUCTURAL (MEDIUM+: real re-render / leak / list issues) from
    // COSMETIC (LOW: inline props, barrels, image dims). Centrality only
    // amplifies structural debt — a hub file full of idiomatic inline props
    // is not a perf hotspot just because 50 files import it, but a real
    // re-render bug in that same hub genuinely is worse than in a leaf.
    const byDet = {};
    for (const f of a.findings) (byDet[f.id] ||= []).push(f);
    let structuralRaw = 0;
    let cosmeticRaw = 0;
    for (const arr of Object.values(byDet)) {
      const w = CONFIG.severityWeight[arr[0].severity] * diminish(arr.length);
      if (SEV_RANK[arr[0].severity] >= SEV_RANK.MEDIUM) structuralRaw += w;
      else cosmeticRaw += w;
    }
    const raw = structuralRaw + cosmeticRaw;
    const fi = fanIn.get(a.rel) || 0;
    const mult = 1 + CONFIG.centralityK * Math.log2(1 + fi) + (a.hasList ? CONFIG.listBonus : 0);
    const debt = +(structuralRaw * mult + cosmeticRaw).toFixed(2);
    const maxSev = a.findings.reduce((m, f) =>
      (SEV_RANK[f.severity] > SEV_RANK[m] ? f.severity : m), 'LOW');
    // index.* files are everywhere in RN; label them by their folder so the
    // map and tooltips stay legible (e.g. "Gallery/index.tsx").
    const base = path.basename(a.rel);
    const label = /^index\./.test(base) ? `${path.basename(path.dirname(a.rel))}/${base}` : base;
    return { id: a.rel, label, findings: a.findings,
      rawDebt: +raw.toFixed(2), fanIn: fi, hasList: a.hasList, debt,
      maxSeverity: a.findings.length ? maxSev : null, parseError: a.parseError };
  });

  // Gate: classify hotspots, assign visual size + color.
  for (const n of nodes) {
    const hasStructural = n.maxSeverity && SEV_RANK[n.maxSeverity] >= SEV_RANK.HIGH;
    n.isHotspot = n.findings.length > 0 && (n.debt >= CONFIG.hotspotDebt || hasStructural);
    if (n.isHotspot) {
      n.val = Math.min(CONFIG.sizeMax, CONFIG.sizeBaseHot + n.debt * CONFIG.sizeK);
      n.color = SEV_COLOR[n.maxSeverity] || SEV_COLOR.MEDIUM;
    } else {
      n.val = CONFIG.sizeCold;
      n.color = COLD_COLOR;
    }
  }

  return { nodes, links };
}

// Top-3 prioritized, ready to paste into Autoresearch.
function topThree(nodes) {
  const hotspots = nodes.filter((n) => n.isHotspot).sort((a, b) => b.debt - a.debt);
  return hotspots.slice(0, 3).map((n, i) => {
    // Pick the dominant finding (highest severity, then first) to drive the preset.
    const dom = [...n.findings].sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity])[0];
    // A useful --target is a component/screen name, not "index". For index.*
    // files fall back to the folder name (Gallery/index.tsx -> Gallery).
    const baseNoExt = path.basename(n.id)
      .replace(/\.(web|ios|android|native)\.(t|j)sx?$/, '').replace(/\.(t|j)sx?$/, '');
    const target = (!baseNoExt || baseNoExt === 'index')
      ? (path.basename(path.dirname(n.id)) || 'App') : baseNoExt;
    return {
      rank: i + 1,
      file: n.id,
      debt: n.debt,
      preset: dom.preset,
      why: `${dom.title}${dom.detail ? ` (${dom.detail})` : ''} at ${n.id}:${dom.line}`,
      paste: `/metrognome ${dom.preset} --target ${target}`,
    };
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main() {
  const args = process.argv.slice(2);
  const quiet = args.includes('--quiet');
  const outIdx = args.indexOf('--out');
  const outFile = outIdx >= 0 ? args[outIdx + 1] : 'graph.json';
  const outValIdx = outIdx >= 0 ? outIdx + 1 : -1; // index of --out's value, if any
  const target = args.find((a, i) => !a.startsWith('--') && i !== outValIdx);

  if (!target) {
    console.error('usage: node perf_scan.mjs <repo-or-src-path> [--out graph.json] [--quiet]');
    process.exit(1);
  }
  const repoRoot = path.resolve(target);
  if (!fs.existsSync(repoRoot)) {
    console.error(`path not found: ${repoRoot}`);
    process.exit(1);
  }

  ALIASES = loadAliases(repoRoot);
  const files = walk(repoRoot);
  const { nodes, links } = build(repoRoot, files);
  const top3 = topThree(nodes);

  const hotspots = nodes.filter((n) => n.isHotspot);
  const findingCount = nodes.reduce((s, n) => s + n.findings.length, 0);
  const byDetector = {};
  for (const n of nodes) for (const f of n.findings) byDetector[f.id] = (byDetector[f.id] || 0) + 1;

  const graph = {
    meta: {
      generatedAt: new Date().toISOString(),
      repoRoot,
      config: CONFIG,
      stats: {
        filesScanned: files.length,
        nodes: nodes.length,
        links: links.length,
        findings: findingCount,
        hotspots: hotspots.length,
        byDetector,
      },
    },
    nodes,
    links,
    top3,
  };

  fs.writeFileSync(outFile, JSON.stringify(graph, (k, v) =>
    (v instanceof Set ? [...v] : v), 2));

  if (!quiet) {
    console.log(`\nmetrognome perf_scan`);
    console.log(`  scanned   ${files.length} files in ${repoRoot}`);
    console.log(`  aliases   ${ALIASES.length ? ALIASES.map((a) => a.prefix || a.exact).join(', ') : '(none found)'}`);
    console.log(`  graph     ${nodes.length} nodes / ${links.length} edges`);
    console.log(`  findings  ${findingCount} total, ${hotspots.length} hotspot module(s)`);
    console.log(`  by detector:`);
    for (const [id, c] of Object.entries(byDetector).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${String(c).padStart(4)}  ${id}`);
    }
    console.log(`\n  Top-3 (paste into /metrognome):`);
    if (!top3.length) console.log(`    (no module cleared the hotspot gate — repo looks clean or thresholds too high)`);
    for (const t of top3) {
      console.log(`    ${t.rank}. [debt ${t.debt}] ${t.paste}`);
      console.log(`        ${t.why}`);
    }
    console.log(`\n  wrote ${outFile}\n`);
  }
}

main();
