import { safeStorage } from 'electron';
import type { SecretStore } from '@concilium/core';

export class ElectronSecretStore implements SecretStore {
  encrypt(value: string): string {
    if (!safeStorage.isEncryptionAvailable()) {
      return Buffer.from(value).toString('base64');
    }
    return safeStorage.encryptString(value).toString('base64');
  }

  decrypt(encrypted: string): string {
    if (!safeStorage.isEncryptionAvailable()) {
      return Buffer.from(encrypted, 'base64').toString('utf-8');
    }
    return safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
  }
}
