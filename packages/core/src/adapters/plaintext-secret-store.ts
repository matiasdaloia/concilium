import type { SecretStore } from '../ports/secret-store.js';

/**
 * Simple base64 secret store for CLI/non-Electron environments.
 * NOT cryptographically secure — use only as fallback.
 */
export class PlaintextSecretStore implements SecretStore {
  encrypt(value: string): string {
    return Buffer.from(value).toString('base64');
  }

  decrypt(encrypted: string): string {
    return Buffer.from(encrypted, 'base64').toString('utf-8');
  }
}
