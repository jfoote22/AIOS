import type { Creds } from '../api/client';

export function validateCreds(value: unknown): Creds {
  const candidate = value as Partial<Creds> | null;
  if (!candidate || typeof candidate.url !== 'string' || typeof candidate.token !== 'string' ||
      !candidate.token.trim() || candidate.token.length > 1024) throw new Error('Invalid pairing credentials.');
  const url = new URL(candidate.url);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      url.search || url.hash || url.pathname !== '/') throw new Error('Enter an HTTP or HTTPS gateway address without a path.');
  return { url: url.origin, token: candidate.token.trim() };
}

interface CredentialIO {
  readSecure(): Promise<string | null>;
  writeSecure(value: string): Promise<void>;
  deleteSecure(): Promise<void>;
  readLegacy(): Promise<string | null>;
  deleteLegacy(): Promise<void>;
}

export function createCredentialStorage(io: CredentialIO) {
  async function write(value: Creds): Promise<Creds> {
    const normalized = validateCreds(value);
    const raw = JSON.stringify(normalized);
    await io.writeSecure(raw);
    if (await io.readSecure() !== raw) throw new Error('Secure credential storage could not be verified.');
    await io.deleteLegacy();
    return normalized;
  }
  return {
    async read(): Promise<Creds | null> {
      const secure = await io.readSecure();
      if (secure) {
        const value = validateCreds(JSON.parse(secure));
        await io.deleteLegacy();
        return value;
      }
      const legacy = await io.readLegacy();
      return legacy ? write(validateCreds(JSON.parse(legacy))) : null;
    },
    write,
    async clear(): Promise<void> {
      // Remove the migration source first, so an interrupted unpair cannot
      // restore an old plaintext token on next launch.
      await io.deleteLegacy();
      await io.deleteSecure();
    },
  };
}
