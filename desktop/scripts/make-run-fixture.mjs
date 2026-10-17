/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

// Rewrites desktop/src/main/__fixtures__/code-run/, the run directory the run viewer tests read, with the built CLI:
// `concilium code --no-judge --agents claude,codex` then `concilium verify-pr`, on fake claude and codex scripts in a
// throwaway repo, HOME and XDG dirs. Nothing real runs and nothing leaves the temp dir but the copied run directory.
// Run it after `npm run build` whenever what a code run writes changes: node desktop/scripts/make-run-fixture.mjs
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = path.join(desktopDir, '..', 'packages', 'cli', 'dist', 'bin', 'concilium.js');
const out = path.join(desktopDir, 'src', 'main', '__fixtures__', 'code-run');

const RUBRIC = [
  { name: 'validates', description: 'sum rejects non-numbers, shown by a test.', weight: 3, evidence: 'gate' },
  { name: 'suite', description: 'The existing tests pass.', weight: 2, evidence: 'gate' },
  { name: 'small', description: 'Only sum.js and its test change.', weight: 1, evidence: 'judgment' },
];

/**
 * A fake agent CLI. As a candidate, claude validates only `a` with a `var` (the lint gate fails) and adds a test;
 * codex validates both arguments. As an adversary each writes a TypeError test for its own argument. It frames the
 * rubric, names one graft (candidate A's sum.test.js), integrates it, and reviews with VERDICT: PASS.
 */
function fakeCli(name) {
  return `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const name = ${JSON.stringify(name)};
const args = process.argv.slice(2).join(' ');
if (args === '--version') { console.log('1.0.0'); process.exit(0); }
if (args === 'auth status') { console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max' })); process.exit(0); }
if (args === 'login status') { console.log('Logged in using ChatGPT'); process.exit(0); }
const say = (text) => {
  if (name === 'claude') console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: text }));
  else {
    console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } }));
    console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }));
  }
  process.exit(0);
};
const prompt = fs.existsSync('council-prompt.md') ? fs.readFileSync('council-prompt.md', 'utf8') : '';
const dir = path.basename(process.cwd());
if (prompt.startsWith('You are reviewing')) say('VERDICT: PASS\\nThe validation and its test match the task.');
if (prompt.startsWith('You are choosing grafts')) {
  say(JSON.stringify({ grafts: [{ candidate: 'A', files: ['sum.test.js'], instruction: 'Take its sum.test.js.', why: 'The base has no test.' }] }));
}
if (prompt) say(JSON.stringify({ criteria: ${JSON.stringify(RUBRIC)} }));
if (dir === 'integration') { fs.writeFileSync('sum.test.js', 'require("./sum")(1, 2);\\n'); say('Folded the test in'); }
if (dir.startsWith('adv-')) {
  const call = name === 'claude' ? "('x', 1)" : "(1, 'x')";
  fs.writeFileSync(name + '-adv.test.js', "let threw = false; try { require('./sum.js')" + call + "; } catch (e) { threw = e instanceof TypeError; } if (!threw) throw new Error('no TypeError');\\n");
  fs.writeFileSync('concilium-adversarial.json', JSON.stringify({ tests: [{ files: [name + '-adv.test.js'], specClause: 'sum rejects non-numbers' }] }));
  say('Wrote a test');
}
if (name === 'claude') {
  fs.writeFileSync('sum.js', 'var check = (a) => { if (typeof a !== "number") throw new TypeError("a"); };\\nmodule.exports = (a, b) => { check(a); return a + b; };\\n');
  fs.writeFileSync('sum.test.js', 'require("./sum")(1, 2);\\n');
  say('1. done: validated a\\n2. done: added sum.test.js\\n3. done: ran the tests\\n4. skipped: nothing else');
}
fs.writeFileSync('sum.js', 'module.exports = (a, b) => {\\n  if (typeof a !== "number" || typeof b !== "number") throw new TypeError("sum takes numbers");\\n  return a + b;\\n};\\n');
say('1. done: validated both\\n2. done\\n3. done: ran the tests\\n4. skipped: nothing else');
`;
}

const sandbox = mkdtempSync(path.join(tmpdir(), 'concilium-run-fixture-'));
try {
  const binDir = path.join(sandbox, 'bin');
  const repo = path.join(sandbox, 'repo');
  const env = {
    PATH: binDir,
    HOME: sandbox,
    XDG_CONFIG_HOME: path.join(sandbox, 'config'),
    XDG_DATA_HOME: path.join(sandbox, 'data'),
    XDG_CACHE_HOME: path.join(sandbox, 'cache'),
    GIT_CONFIG_NOSYSTEM: '1',
  };
  const git = (...args) => execFileSync('git', args, { cwd: repo, env: { ...env, PATH: process.env.PATH }, encoding: 'utf8' });
  const concilium = (...args) => spawnSync(process.execPath, [cli, ...args], { cwd: repo, env, encoding: 'utf8' });

  writeFileSync(path.join(sandbox, '.gitconfig'), '[user]\n\tname = Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n');
  mkdirSync(binDir);
  for (const name of ['claude', 'codex']) writeFileSync(path.join(binDir, name), fakeCli(name), { mode: 0o755 });
  symlinkSync(execFileSync('which', ['git'], { encoding: 'utf8' }).trim(), path.join(binDir, 'git'));
  mkdirSync(path.join(repo, '.concilium'), { recursive: true });
  git('init', '-q');
  writeFileSync(path.join(repo, 'sum.js'), 'module.exports = (a, b) => a + b;\n');
  writeFileSync(path.join(repo, 'run-tests.js'), [
    "const fs = require('node:fs');",
    'let failed = 0;',
    "for (const f of fs.readdirSync('.').filter((f) => f.endsWith('.test.js'))) { try { require('./' + f); } catch (e) { failed++; console.error(f + ': ' + e.message); } }",
    'process.exit(failed ? 1 : 0);',
    '',
  ].join('\n'));
  writeFileSync(path.join(repo, 'lint.js'), "const fs = require('node:fs');\nif (fs.readFileSync('sum.js', 'utf8').startsWith('var ')) { console.error('var in sum.js'); process.exit(1); }\n");
  writeFileSync(path.join(repo, '.concilium', 'verify.yaml'), `gates:\n  lint: '${JSON.stringify(process.execPath)} lint.js'\n  test: '${JSON.stringify(process.execPath)} run-tests.js'\n`);
  git('add', '.');
  git('commit', '-q', '-m', 'init');

  const run = concilium('code', '--json', '--no-judge', '--agents', 'claude,codex', 'sum must reject non-numbers');
  if (run.status !== 0) throw new Error(`concilium code exited ${run.status}:\n${run.stderr.slice(-2000)}`);
  const id = JSON.parse(run.stdout).id;
  const verify = concilium('verify-pr', id);
  if (verify.status !== 0) throw new Error(`concilium verify-pr exited ${verify.status}:\n${verify.stdout}${verify.stderr.slice(-2000)}`);

  rmSync(out, { recursive: true, force: true });
  cpSync(path.join(sandbox, 'data', 'concilium', 'runs', id), out, { recursive: true });
  console.log(`Wrote run ${id} to ${out}`);
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}
