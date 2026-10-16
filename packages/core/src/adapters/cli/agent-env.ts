/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

/**
 * Variables that let a process push or call a forge as the user: forge tokens, askpass helpers, the ssh agent and
 * custom ssh commands. Agent CLIs keep their own logins, which live in their own config, not in these.
 */
export const PUSH_CREDENTIAL_VARS = [
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
  'GITLAB_TOKEN',
  'GL_TOKEN',
  'BITBUCKET_TOKEN',
  'GIT_ASKPASS',
  'SSH_ASKPASS',
  'SSH_AUTH_SOCK',
  'GIT_SSH',
  'GIT_SSH_COMMAND',
] as const;

/**
 * The environment an agent CLI runs in: `env` without push credentials, with git's credential helpers reset (an
 * empty `credential.helper` at command scope, which beats every config file) and its prompts off.
 *
 * Limits: an agent can still pass its own `git -c credential.helper=...`, read a stored credential file such as
 * `~/.git-credentials`, or use an ssh key on disk that has no passphrase. This takes the credentials out of reach of
 * a plain `git push`; it is not a sandbox.
 */
export function withoutPushCredentials(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (!(PUSH_CREDENTIAL_VARS as readonly string[]).includes(name)) clean[name] = value;
  }
  const count = Number.parseInt(env.GIT_CONFIG_COUNT ?? '0', 10) || 0;
  clean.GIT_CONFIG_COUNT = String(count + 1);
  clean[`GIT_CONFIG_KEY_${count}`] = 'credential.helper';
  clean[`GIT_CONFIG_VALUE_${count}`] = '';
  clean.GIT_TERMINAL_PROMPT = '0';
  clean.GCM_INTERACTIVE = 'never';
  return clean;
}
