/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PROVIDER_IDS } from '../domain/agent/providers.js';
import { RolesValidationError } from '../domain/roles/role-rules.js';
import { parseRoleFlags } from '../domain/roles/roles.js';
import { FakeCliDriver } from '../adapters/cli/fake-cli-driver.js';
import { JsonConfigStore } from '../adapters/json-config-store.js';
import { JsonRunRepository } from '../adapters/json-run-repository.js';
import { PlaintextSecretStore } from '../adapters/plaintext-secret-store.js';
import { setLogLevel } from '../shared/logger.js';
import { createConciliumRuntime, NO_AGENT_CLI_MESSAGE } from './create-concilium.js';

/*
 * Precedence, highest wins, per role:
 *
 *   Code roles:        flag (`--role`, `--agents`)                 > .concilium/factory.yaml > saved (`config set <role>`) > default
 *   Jurors, chairman:  flag (`--juror-models`, `--chairman`)       > COUNCIL_MODELS / CHAIRMAN_MODEL > factory.yaml > saved > default
 */

describe('role resolution', () => {
  let dir: string;
  let repo: string;
  let installed: string[];

  beforeAll(() => setLogLevel('error'));

  beforeEach(async () => {
    for (const name of ['OPENROUTER_API_KEY', 'COUNCIL_MODELS', 'CHAIRMAN_MODEL']) vi.stubEnv(name, '');
    dir = await mkdtemp(join(tmpdir(), 'concilium-roles-'));
    repo = join(dir, 'repo');
    mkdirSync(join(repo, '.git'), { recursive: true });
    installed = ['claude', 'codex'];
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
  });

  function runtime() {
    const rt = createConciliumRuntime({
      configStore: new JsonConfigStore(join(dir, 'config')),
      secretStore: new PlaintextSecretStore(),
      runRepository: new JsonRunRepository(join(dir, 'data')),
    });
    for (const id of PROVIDER_IDS) rt.drivers.set(id, new FakeCliDriver({ id, ...(installed.includes(id) ? {} : { detection: { installed: false } }) }));
    return rt;
  }

  function writeFactory(text: string, at = repo): void {
    mkdirSync(join(at, '.concilium'), { recursive: true });
    writeFileSync(join(at, '.concilium', 'factory.yaml'), text);
  }

  it('should default every code role from detection when nothing is configured', async () => {
    expect(await runtime().resolveCodeRoles({ repoDir: repo })).toEqual({
      planner: { value: 'claude', source: 'default' },
      implementer: { value: ['claude', 'codex'], source: 'default' },
      adversary: { value: 'same-as-implementer', source: 'default' },
      judge: { value: 'auto', source: 'default' },
      integrator: { value: 'winner', source: 'default' },
    });
  });

  it('should take each code role from flags, then factory.yaml, then saved config', async () => {
    const rt = runtime();
    await rt.configService.saveRoles({ planner: 'gemini', judge: 'gemini', integrator: 'claude:claude-opus-5-5', adversary: ['gemini'] });
    writeFactory('roles:\n  planner: claude:claude-opus-5-5\n  judge: codex:gpt-5.2\n  implementer: [claude:claude-opus-5-5, codex]\n');
    const roles = await rt.resolveCodeRoles({ repoDir: repo, flags: parseRoleFlags(['judge=gemini:gemini-3-pro']) });
    expect(roles).toEqual({
      planner: { value: 'claude:claude-opus-5-5', source: 'repo' },
      implementer: { value: ['claude:claude-opus-5-5', 'codex'], source: 'repo' },
      adversary: { value: ['gemini'], source: 'saved' },
      judge: { value: 'gemini:gemini-3-pro', source: 'flag' },
      integrator: { value: 'claude:claude-opus-5-5', source: 'saved' },
    });
  });

  it('should not detect agent CLIs when a source names the implementers', async () => {
    installed = [];
    const rt = runtime();
    await expect(rt.resolveCodeRoles({ repoDir: repo })).rejects.toThrow(NO_AGENT_CLI_MESSAGE);
    const roles = await rt.resolveCodeRoles({ repoDir: repo, flags: parseRoleFlags(['implementer=codex:gpt-5.2,claude']) });
    expect(roles.implementer).toEqual({ value: ['codex:gpt-5.2', 'claude'], source: 'flag' });
    expect(roles.planner).toEqual({ value: 'codex:gpt-5.2', source: 'default' });
  });

  it('should find factory.yaml from a subdirectory up to the repo root, and read it at use time', async () => {
    const rt = runtime();
    const sub = join(repo, 'packages', 'app');
    mkdirSync(sub, { recursive: true });
    writeFactory('roles:\n  judge: codex\n');
    expect((await rt.resolveCodeRoles({ repoDir: sub })).judge).toEqual({ value: 'codex', source: 'repo' });
    writeFactory('roles:\n  judge: gemini\n');
    expect((await rt.resolveCodeRoles({ repoDir: sub })).judge).toEqual({ value: 'gemini', source: 'repo' });
    // A factory.yaml above the repo root is not this repo's.
    writeFactory('roles:\n  judge: opencode\n', dir);
    writeFactory('checks: {}\n');
    expect((await rt.resolveCodeRoles({ repoDir: sub })).judge).toEqual({ value: 'auto', source: 'default' });
  });

  it('should reject an invalid factory.yaml naming its path, each key and every violation', async () => {
    writeFactory('roles:\n  judge: [claude, codex]\n  planer: claude\n');
    const err = await runtime().resolveCodeRoles({ repoDir: repo }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RolesValidationError);
    const path = join(repo, '.concilium', 'factory.yaml');
    expect((err as RolesValidationError).violations.map((v) => [v.rule, v.source, v.at])).toEqual([
      ['list-for-single-role', 'repo', `${path} roles.judge`],
      ['unknown-role', 'repo', `${path} roles.planer`],
    ]);
  });

  it('should rank jurors and the chairman as flag, env, factory.yaml, saved, default, with the source of each', async () => {
    const rt = runtime();
    expect((await rt.resolveRoleMap({ repoDir: repo })).roles).toMatchObject({
      juror: { value: ['claude', 'codex'], source: 'default' },
      chairman: { value: 'codex', source: 'default' },
    });

    await rt.configService.saveCouncilConfig({ councilModels: ['claude'], chairmanModel: 'claude' });
    expect((await rt.resolveRoleMap({ repoDir: repo })).roles).toMatchObject({ juror: { value: ['claude'], source: 'saved' }, chairman: { value: 'claude', source: 'saved' } });

    writeFactory('roles:\n  juror: [codex:gpt-5.2]\n  chairman: codex\n');
    expect((await rt.resolveRoleMap({ repoDir: repo })).roles).toMatchObject({ juror: { value: ['codex:gpt-5.2'], source: 'repo' }, chairman: { value: 'codex', source: 'repo' } });
    // The plan council reads the same file when given the repo.
    expect((await rt.resolveCouncilConfig({}, { repoDir: repo })).config).toMatchObject({ councilModels: ['codex:gpt-5.2'], chairmanModel: 'codex' });
    expect((await rt.resolveCouncilConfig()).config).toMatchObject({ councilModels: ['claude'], chairmanModel: 'claude' });

    vi.stubEnv('COUNCIL_MODELS', 'gemini');
    vi.stubEnv('CHAIRMAN_MODEL', 'gemini');
    expect((await rt.resolveRoleMap({ repoDir: repo })).roles).toMatchObject({ juror: { value: ['gemini'], source: 'env' }, chairman: { value: 'gemini', source: 'env' } });

    const flags = parseRoleFlags(['juror=claude', 'chairman=codex']);
    expect((await rt.resolveRoleMap({ repoDir: repo, flags })).roles).toMatchObject({ juror: { value: ['claude'], source: 'flag' }, chairman: { value: 'codex', source: 'flag' } });
  });

  it('should take the verifier from flags, then factory.yaml, then saved config, else auto, without detecting', async () => {
    installed = [];
    const rt = runtime();
    const no = { value: false, source: 'default' };
    expect(await rt.resolveVerifier({ repoDir: repo })).toEqual({ value: 'auto', source: 'default', allowSameFamily: no });
    await rt.configService.saveRoles({ verifier: 'claude' });
    expect(await rt.resolveVerifier({ repoDir: repo })).toEqual({ value: 'claude', source: 'saved', allowSameFamily: no });
    writeFactory('roles:\n  verifier: codex:gpt-5.2\n');
    expect(await rt.resolveVerifier({ repoDir: repo })).toEqual({ value: 'codex:gpt-5.2', source: 'repo', allowSameFamily: no });
    expect(await rt.resolveVerifier({ repoDir: repo, flags: parseRoleFlags(['verifier=gemini']) })).toEqual({ value: 'gemini', source: 'flag', allowSameFamily: no });
    expect((await rt.resolveRoleMap({ repoDir: repo })).roles.verifier).toEqual({ value: 'codex:gpt-5.2', source: 'repo' });
  });

  it('should take the same-family verifier opt-in from the flag, then factory.yaml, then saved config, else no', async () => {
    installed = [];
    const rt = runtime();
    const allow = async (flag?: boolean) => (await rt.resolveVerifier({ repoDir: repo, allowSameFamily: flag })).allowSameFamily;
    expect(await allow()).toEqual({ value: false, source: 'default' });
    await rt.configService.saveAllowSameFamilyVerifier(true);
    expect(await allow()).toEqual({ value: true, source: 'saved' });
    writeFactory('allow-same-family-verifier: false\n');
    expect(await allow()).toEqual({ value: false, source: 'repo' });
    expect(await allow(true)).toEqual({ value: true, source: 'flag' });
  });

  it('should show the role map without an agent CLI, with a note instead of failing', async () => {
    installed = [];
    writeFactory('roles:\n  judge: codex\n');
    const map = await runtime().resolveRoleMap({ repoDir: repo });
    expect(map.factoryPath).toBe(join(repo, '.concilium', 'factory.yaml'));
    expect(map.roles.implementer).toEqual({ value: [], source: 'default' });
    expect(map.roles.judge).toEqual({ value: 'codex', source: 'repo' });
    expect(map.notes[0]).toBe(NO_AGENT_CLI_MESSAGE);
  });
});
