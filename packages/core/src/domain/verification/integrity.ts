/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

/** One file of a `git diff` between the base and a candidate head. */
export type FileDiff = {
  path: string;
  /** The path on the base, for renames and deletions. */
  oldPath: string;
  status: 'added' | 'deleted' | 'modified' | 'renamed';
  /** Each hunk as git prints it, `@@` header first. */
  hunks: string[];
};

/** A dependency manifest the candidate changed, read at the base and at the head (null where it does not exist). */
export type ManifestChange = { path: string; base: string | null; head: string | null };

/** Weakening tests disqualifies a candidate; everything else is a scored penalty. */
export type IntegrityRule = 'deleted-test' | 'skipped-test' | 'lowered-coverage' | 'gate-config' | 'added-dependency';

export type IntegrityFinding = {
  rule: IntegrityRule;
  severity: 'disqualify' | 'penalty';
  path: string;
  message: string;
  /** The offending hunk, or the lines that show the problem. */
  evidence: string;
};

const SEVERITY: Record<IntegrityRule, IntegrityFinding['severity']> = {
  'deleted-test': 'disqualify',
  'skipped-test': 'disqualify',
  'lowered-coverage': 'disqualify',
  'gate-config': 'penalty',
  'added-dependency': 'penalty',
};

const EVIDENCE_LIMIT = 2000;

const TEST_FILE = [
  /(^|\/)(__tests__|tests?|specs?)\//,
  /\.(test|spec)\.[cm]?[jt]sx?$/,
  /_test\.go$/,
  /(^|\/)test_[^/]+\.py$/,
  /_test\.py$/,
  /(Test|Tests|Spec)\.(java|kt|scala|cs)$/,
];

/** Markers that skip a test or focus the run on a few, so the rest never run. */
const SKIP_MARKERS = [
  /\b(?:it|test|describe|suite|context|bench)\.(?:skip|only)\b/,
  /(?<![.\w])(?:xit|xtest|xdescribe|fit|fdescribe)\s*\(/,
  /@(?:Disabled|Ignore)\b/,
  /\bt\.Skip(?:Now|f)?\s*\(/,
  /@pytest\.mark\.(?:skip|skipif|xfail)\b/,
  /\bpytest\.skip\s*\(/,
  /@unittest\.skip/,
  /#\[ignore\]/,
];

const PROSE_FILE = /\.(md|mdx|txt|rst|adoc)$/i;

/** Files whose numbers may be coverage thresholds. */
const COVERAGE_CONFIG = /(^|\/)((vitest|vite|jest|karma)\.config\.[cm]?[jt]s|\.nycrc(\.json|\.ya?ml)?|\.c8rc(\.json)?|package\.json|pyproject\.toml|setup\.cfg|\.coveragerc|tox\.ini|pytest\.ini|\.?codecov\.ya?ml|Makefile)$/;
const COVERAGE_KEY = /\b(branches|functions|lines|statements|fail[_-]under|cov-fail-under|minimum[_-]?coverage|threshold)\b["']?\s*[:=]?\s*["']?(\d+(?:\.\d+)?)/i;

/** Lint, type-check, test runner and CI configuration, plus Concilium's own gate config. */
const GATE_CONFIG = [
  /(^|\/)\.eslintrc(\.[a-z]+)?$/,
  /(^|\/)eslint\.config\.[cm]?[jt]s$/,
  /(^|\/)\.eslintignore$/,
  /(^|\/)biome\.jsonc?$/,
  /(^|\/)\.oxlintrc\.json$/,
  /(^|\/)\.golangci\.ya?ml$/,
  /(^|\/)\.?ruff\.toml$/,
  /(^|\/)\.flake8$/,
  /(^|\/)\.pylintrc$/,
  /(^|\/)mypy\.ini$/,
  /(^|\/)clippy\.toml$/,
  /(^|\/)tsconfig[^/]*\.json$/,
  /(^|\/)(vitest|jest)\.config\.[cm]?[jt]s$/,
  /(^|\/)(pytest|tox)\.ini$/,
  /^\.github\/workflows\//,
  /^\.gitlab-ci\.ya?ml$/,
  /^\.circleci\//,
  /^\.buildkite\//,
  /(^|\/)Jenkinsfile$/,
  /^azure-pipelines\.ya?ml$/,
  /^\.concilium\//,
];
/** A `package.json` line that defines one of the gate scripts. */
const GATE_SCRIPT_LINE = /^[+-]\s*"(test|lint|typecheck)(:[^"]*)?"\s*:/;

export const DEPENDENCY_MANIFEST = /(^|\/)(package\.json|go\.mod|Cargo\.toml|requirements[^/]*\.txt)$/;

export function isTestFile(path: string): boolean {
  return TEST_FILE.some((pattern) => pattern.test(path));
}

const RENAME = /^rename (from|to) (.+)$/;

function unquote(path: string): string {
  return path.startsWith('"') && path.endsWith('"') ? JSON.parse(path) as string : path;
}

/** Parses `git diff -M` output into files and hunks. */
export function parseDiff(text: string): FileDiff[] {
  const files: FileDiff[] = [];
  let file: FileDiff | null = null;
  let hunk: string[] | null = null;
  const closeHunk = () => {
    if (file && hunk) file.hunks.push(hunk.join('\n'));
    hunk = null;
  };

  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      closeHunk();
      const match = /^diff --git (?:"?a\/)(.+?)"? (?:"?b\/)(.+?)"?$/.exec(line);
      file = { path: match?.[2] ?? '', oldPath: match?.[1] ?? '', status: 'modified', hunks: [] };
      files.push(file);
      continue;
    }
    if (!file) continue;
    if (hunk) {
      if (line.startsWith('@@')) {
        closeHunk();
      } else if (/^[ +\-\\]/.test(line) || line === '') {
        hunk.push(line);
        continue;
      } else {
        closeHunk();
      }
    }
    const rename = RENAME.exec(line);
    if (line.startsWith('@@')) hunk = [line];
    else if (line.startsWith('new file mode')) file.status = 'added';
    else if (line.startsWith('deleted file mode')) file.status = 'deleted';
    else if (rename?.[1] === 'to') file.path = unquote(rename[2]);
    else if (rename) [file.status, file.oldPath] = ['renamed', unquote(rename[2])];
    else if (line.startsWith('--- a/')) file.oldPath = unquote(line.slice('--- a/'.length));
    else if (line.startsWith('+++ b/')) file.path = unquote(line.slice('+++ b/'.length));
  }
  closeHunk();
  return files;
}

function truncate(text: string): string {
  return text.length <= EVIDENCE_LIMIT ? text : `${text.slice(0, EVIDENCE_LIMIT)}\n… (${text.length - EVIDENCE_LIMIT} more characters)`;
}

function hunkLines(hunk: string, sign: '+' | '-'): string[] {
  return hunk.split('\n').slice(1).filter((line) => line.startsWith(sign)).map((line) => line.slice(1));
}

function finding(rule: IntegrityRule, path: string, message: string, evidence: string): IntegrityFinding {
  return { rule, severity: SEVERITY[rule], path, message, evidence: truncate(evidence) };
}

function deletedTests(file: FileDiff): IntegrityFinding[] {
  if (!isTestFile(file.oldPath)) return [];
  if (file.status === 'deleted') return [finding('deleted-test', file.oldPath, `deleted the test file ${file.oldPath}`, file.hunks.join('\n') || `deleted ${file.oldPath}`)];
  if (file.status === 'renamed' && !isTestFile(file.path)) {
    return [finding('deleted-test', file.oldPath, `moved the test file ${file.oldPath} to ${file.path}, where it no longer runs as a test`, `rename ${file.oldPath} => ${file.path}`)];
  }
  return [];
}

function count(lines: string[], pattern: RegExp): number {
  return lines.filter((line) => pattern.test(line)).length;
}

function skippedTests(file: FileDiff): IntegrityFinding[] {
  if (file.status === 'deleted' || PROSE_FILE.test(file.path)) return [];
  const added = file.hunks.flatMap((h) => hunkLines(h, '+'));
  const removed = file.hunks.flatMap((h) => hunkLines(h, '-'));
  const findings: IntegrityFinding[] = [];
  for (const marker of SKIP_MARKERS) {
    if (count(added, marker) <= count(removed, marker)) continue;
    const hunk = file.hunks.find((h) => hunkLines(h, '+').some((line) => marker.test(line))) ?? '';
    const line = added.find((l) => marker.test(l))!.trim();
    findings.push(finding('skipped-test', file.path, `skips or focuses tests in ${file.path}: ${line}`, hunk));
  }
  return findings;
}

function thresholds(lines: string[]): Map<string, number> {
  const values = new Map<string, number>();
  for (const line of lines) {
    const match = COVERAGE_KEY.exec(line);
    if (match) values.set(match[1].toLowerCase().replace(/_/g, '-'), Number(match[2]));
  }
  return values;
}

function loweredCoverage(file: FileDiff): IntegrityFinding[] {
  if (!COVERAGE_CONFIG.test(file.path)) return [];
  const findings: IntegrityFinding[] = [];
  for (const hunk of file.hunks) {
    const before = thresholds(hunkLines(hunk, '-'));
    for (const [key, value] of thresholds(hunkLines(hunk, '+'))) {
      const old = before.get(key);
      if (old !== undefined && value < old) {
        findings.push(finding('lowered-coverage', file.path, `lowered the ${key} coverage threshold in ${file.path} from ${old} to ${value}`, hunk));
      }
    }
  }
  return findings;
}

function gateConfig(file: FileDiff): IntegrityFinding[] {
  const path = file.status === 'deleted' ? file.oldPath : file.path;
  if (GATE_CONFIG.some((pattern) => pattern.test(path) || pattern.test(file.oldPath))) {
    return [finding('gate-config', path, `${file.status === 'deleted' ? 'deleted' : 'edited'} the gate config ${path}`, file.hunks.join('\n') || `${file.status} ${path}`)];
  }
  if (/(^|\/)package\.json$/.test(path)) {
    const hunk = file.hunks.find((h) => h.split('\n').some((line) => GATE_SCRIPT_LINE.test(line)));
    if (hunk) return [finding('gate-config', path, `changed a test, lint or typecheck script in ${path}`, hunk)];
  }
  return [];
}

const PACKAGE_SECTIONS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];

function packageJsonDeps(text: string): Set<string> {
  try {
    const pkg = JSON.parse(text) as Record<string, unknown>;
    return new Set(PACKAGE_SECTIONS.flatMap((section) => Object.keys((pkg[section] as Record<string, unknown> | undefined) ?? {})));
  } catch {
    return new Set();
  }
}

function requirementsDeps(text: string): Set<string> {
  const names = new Set<string>();
  for (const line of text.split('\n')) {
    const match = /^\s*([A-Za-z0-9][A-Za-z0-9_.-]*)/.exec(line);
    if (match && !line.trim().startsWith('-')) names.add(match[1].toLowerCase().replace(/_/g, '-'));
  }
  return names;
}

function goModDeps(text: string): Set<string> {
  const names = new Set<string>();
  for (const line of text.split('\n')) {
    if (line.includes('=>')) continue;
    const match = /^\s*(?:require\s+)?([^\s()]+)\s+v\d\S*/.exec(line);
    if (match && match[1] !== 'module' && match[1] !== 'go') names.add(match[1]);
  }
  return names;
}

function cargoDeps(text: string): Set<string> {
  const names = new Set<string>();
  let inDeps = false;
  for (const line of text.split('\n')) {
    const section = /^\s*\[([^\]]+)\]/.exec(line);
    if (section) {
      const table = /(?:^|\.)(?:dev-|build-)?dependencies\.([A-Za-z0-9_-]+)$/.exec(section[1]);
      if (table) names.add(table[1]);
      inDeps = /(?:^|\.)(?:dev-|build-)?dependencies$/.test(section[1]);
      continue;
    }
    const entry = /^\s*([A-Za-z0-9_-]+)\s*=/.exec(line);
    if (inDeps && entry) names.add(entry[1]);
  }
  return names;
}

function dependencies(path: string, text: string): Set<string> {
  if (/package\.json$/.test(path)) return packageJsonDeps(text);
  if (/go\.mod$/.test(path)) return goModDeps(text);
  if (/Cargo\.toml$/.test(path)) return cargoDeps(text);
  return requirementsDeps(text);
}

function addedDependencies(manifest: ManifestChange, diff: FileDiff | undefined): IntegrityFinding[] {
  if (manifest.head === null) return [];
  const before = manifest.base === null ? new Set<string>() : dependencies(manifest.path, manifest.base);
  const added = [...dependencies(manifest.path, manifest.head)].filter((name) => !before.has(name));
  if (added.length === 0) return [];
  const evidence = diff?.hunks.filter((h) => added.some((name) => hunkLines(h, '+').some((line) => line.includes(name)))).join('\n');
  return [finding('added-dependency', manifest.path, `added ${added.length === 1 ? 'a dependency' : 'dependencies'} in ${manifest.path}: ${added.join(', ')}`, evidence || added.join('\n'))];
}

/** Tier 0 integrity checks on a candidate's diff against the base. Deterministic, no model involved. */
export function checkIntegrity(files: FileDiff[], manifests: ManifestChange[] = []): IntegrityFinding[] {
  return [
    ...files.flatMap((file) => [...deletedTests(file), ...skippedTests(file), ...loweredCoverage(file), ...gateConfig(file)]),
    ...manifests.flatMap((m) => addedDependencies(m, files.find((f) => f.path === m.path))),
  ];
}
