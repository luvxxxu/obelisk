import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { config } from '../config';

/**
 * Sealing for secrets the server must read back later (users' own third-party API keys).
 *
 * Format v2 — `v2.<kid>.<iv>.<tag>.<body>`: AES-256-GCM with a fresh 96-bit IV per value, the owner
 * (`context`, e.g. "jev-key:<user id>") bound in as associated data so a value copied into another
 * row doesn't open, and `kid` naming the key that sealed it so keys can rotate without breaking.
 *
 * The key ring, newest first:
 *  1. SECRET_KEY — the sealing key whenever it is set. Production should set it
 *     (`openssl rand -base64 32`), so that the database password alone never opens stored keys.
 *  2. SECRET_KEY_PREVIOUS — comma-separated older SECRET_KEYs, kept only to open values sealed before
 *     a rotation (they are sealed again with the new key on next use / at boot).
 *  3. The database password — the sealing key only while SECRET_KEY is unset, and a reader after
 *     that so adding SECRET_KEY later breaks nothing. Only the password counts, not the whole
 *     DATABASE_URL: a copied database, a renamed host or an added query option keeps the same key.
 *
 * v1 values (sealed with SECRET_KEY or the whole DATABASE_URL, no owner binding) still open.
 * Anything opened with a key other than the current sealing key comes back `stale` so the caller
 * can seal it again.
 */

const SALT = 'obelisk';
const KEY_INFO_V2 = 'obelisk:sealed-secret:v2';
const KID_INFO = 'obelisk:sealed-secret:kid';
const KEY_INFO_V1 = 'obelisk:sealed-secret:v1';

const derive = (material: string, info: string, length = 32) => Buffer.from(hkdfSync('sha256', material, SALT, info, length));

/** The password part of a connection string; the whole string when it has none (socket / trust auth). */
export function databasePasswordMaterial(databaseUrl: string): string {
  try {
    const password = new URL(databaseUrl).password;
    if (password) return `db-password:${decodeURIComponent(password)}`;
  } catch {}
  return `db-url:${databaseUrl}`;
}

export interface Opened {
  value: string;
  /** Sealed with an older key or the v1 format: seal it again with `seal`. */
  stale: boolean;
}

export interface KeyRingOptions {
  secretKey?: string | null;
  previousSecretKeys?: string[];
  databaseUrl: string;
}

export interface KeyRing {
  seal(plain: string, context: string): string;
  /** null when no key in the ring opens it, the context differs, or it isn't a sealed value. */
  open(sealed: string, context: string): Opened | null;
  /** Where the sealing key comes from. */
  readonly source: 'secret-key' | 'database-password';
}

export function createKeyRing({ secretKey, previousSecretKeys = [], databaseUrl }: KeyRingOptions): KeyRing {
  const secret = secretKey?.trim() || null;
  const previous = previousSecretKeys.map((k) => k.trim()).filter(Boolean);
  const materials = [...new Set([...(secret ? [secret] : []), ...previous, databasePasswordMaterial(databaseUrl)])];
  const ring = materials.map((m) => ({ kid: derive(m, KID_INFO, 6).toString('base64url'), key: derive(m, KEY_INFO_V2) }));
  const primary = ring[0]!;
  // v1 derived its key from SECRET_KEY when set, otherwise from the whole DATABASE_URL.
  const legacy = [...new Set([...(secret ? [secret] : []), ...previous, databaseUrl])].map((m) => derive(m, KEY_INFO_V1));

  const decrypt = (key: Buffer, iv: string, tag: string, body: string, aad: Buffer | null): string | null => {
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
      if (aad) decipher.setAAD(aad);
      decipher.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8');
    } catch {
      return null;
    }
  };

  return {
    source: secret ? 'secret-key' : 'database-password',

    seal(plain, context) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', primary.key, iv);
      cipher.setAAD(Buffer.from(context, 'utf8'));
      const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
      return ['v2', primary.kid, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), body.toString('base64url')].join('.');
    },

    open(sealed, context) {
      const parts = sealed.split('.');
      if (parts[0] === 'v2' && parts.length === 5) {
        const [, kid, iv, tag, body] = parts as [string, string, string, string, string];
        const entry = ring.find((r) => r.kid === kid);
        if (!entry || !iv || !tag) return null;
        const value = decrypt(entry.key, iv, tag, body, Buffer.from(context, 'utf8'));
        return value === null ? null : { value, stale: entry !== primary };
      }
      if (parts[0] === 'v1' && parts.length === 4) {
        const [, iv, tag, body] = parts as [string, string, string, string];
        if (!iv || !tag) return null;
        for (const key of legacy) {
          const value = decrypt(key, iv, tag, body, null);
          if (value !== null) return { value, stale: true };
        }
      }
      return null;
    },
  };
}

const keyRing = createKeyRing({
  secretKey: process.env.SECRET_KEY,
  previousSecretKeys: (process.env.SECRET_KEY_PREVIOUS ?? '').split(','),
  databaseUrl: config.databaseUrl,
});

export const sealingKeySource = keyRing.source;
export const seal = (plain: string, context: string) => keyRing.seal(plain, context);
export const unseal = (sealed: string, context: string) => keyRing.open(sealed, context);
