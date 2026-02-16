import { join } from 'node:path';
import { homedir } from 'node:os';

export function getConfigDir(): string {
  return process.env.XDG_CONFIG_HOME
    ? join(process.env.XDG_CONFIG_HOME, 'concilium')
    : join(homedir(), '.config', 'concilium');
}

export function getDataDir(): string {
  return process.env.XDG_DATA_HOME
    ? join(process.env.XDG_DATA_HOME, 'concilium')
    : join(homedir(), '.local', 'share', 'concilium');
}

export function getCacheDir(): string {
  return process.env.XDG_CACHE_HOME
    ? join(process.env.XDG_CACHE_HOME, 'concilium')
    : join(homedir(), '.cache', 'concilium');
}
