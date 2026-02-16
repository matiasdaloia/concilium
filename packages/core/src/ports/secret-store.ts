export interface SecretStore {
  encrypt(value: string): string;
  decrypt(encrypted: string): string;
}
