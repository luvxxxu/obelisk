import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { config } from '../config';

/**
 * Sealing for secrets the server must read back later (users' own third-party API keys).
 * AES-256-GCM with a key derived from SECRET_KEY, or — when that is not set — from
 * DATABASE_URL, which holds the database password but never lives inside the database.
 * A leaked dump or backup alone therefore can't reveal the keys. Rotating whichever
 * secret the key comes from makes stored keys unreadable; users then enter them again.
 */
const material = process.env.SECRET_KEY?.trim() || config.databaseUrl;
const key = Buffer.from(hkdfSync('sha256', material, 'obelisk', 'obelisk:sealed-secret:v1', 32));
const VERSION = 'v1';

export function seal(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [VERSION, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), body.toString('base64url')].join('.');
}

/** null when the value was sealed with another key, or isn't a sealed value at all. */
export function unseal(sealed: string): string | null {
  const [v, iv, tag, body] = sealed.split('.');
  if (v !== VERSION || !iv || !tag || body === undefined) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
