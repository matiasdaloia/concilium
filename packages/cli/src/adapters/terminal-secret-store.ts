import type { SecretStore } from '@concilium/core';

/**
 * Terminal-based secret store that uses environment variables as primary source,
 * falling back to plaintext base64 encoding for stored preferences.
 */
export class TerminalSecretStore implements SecretStore {
  encrypt(value: string): string {
    return Buffer.from(value).toString('base64');
  }

  decrypt(encrypted: string): string {
    return Buffer.from(encrypted, 'base64').toString('utf-8');
  }
}
