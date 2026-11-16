import { describe, expect, test } from 'bun:test';
import { createCipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { createKeyRing, databasePasswordMaterial } from '../src/common/secret';

const DB = (name: string, password = 'pw-1') => `postgres://obelisk:${password}@db:5432/${name}`;
const ME = 'jev-key:user-1';

/** A value as the v1 code sealed it: key from SECRET_KEY or the whole DATABASE_URL, no owner binding. */
function sealV1(plain: string, material: string): string {
  const key = Buffer.from(hkdfSync('sha256', material, 'obelisk', 'obelisk:sealed-secret:v1', 32));
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), body.toString('base64url')].join('.');
}

describe('v2 sealing', () => {
  const ring = createKeyRing({ secretKey: 'k'.repeat(44), databaseUrl: DB('obelisk') });

  test('round-trips, hides the value, and uses a fresh IV every time', () => {
    const sealed = ring.seal('apikey_secret_value', ME);
    expect(sealed.startsWith('v2.')).toBe(true);
    expect(sealed.split('.')).toHaveLength(5);
    expect(sealed).not.toContain('apikey_secret_value');
    expect(ring.open(sealed, ME)).toEqual({ value: 'apikey_secret_value', stale: false });
    expect(ring.seal('x', ME)).not.toBe(ring.seal('x', ME));
  });

  test('refuses tampering, another owner, and garbage', () => {
    const sealed = ring.seal('apikey_secret_value', ME);
    const parts = sealed.split('.');
    parts[4] = parts[4]!.slice(0, -2) + (parts[4]!.endsWith('A') ? 'BB' : 'AA');
    expect(ring.open(parts.join('.'), ME)).toBeNull();
    expect(ring.open(sealed, 'jev-key:user-2')).toBeNull();
    expect(ring.open('not-sealed', ME)).toBeNull();
    expect(ring.open('v2.x.y.z', ME)).toBeNull();
  });

  test('a key from another server does not open it', () => {
    const other = createKeyRing({ secretKey: 'o'.repeat(44), databaseUrl: DB('obelisk') });
    expect(other.open(ring.seal('apikey', ME), ME)).toBeNull();
  });
});

describe('without SECRET_KEY: the database password, not the whole URL', () => {
  test('a copied database or another host name opens the same values', () => {
    const a = createKeyRing({ databaseUrl: DB('obelisk') });
    const copy = createKeyRing({ databaseUrl: 'postgres://obelisk:pw-1@localhost:54329/obelisk_copy?sslmode=disable' });
    expect(a.source).toBe('database-password');
    expect(copy.open(a.seal('apikey', ME), ME)).toEqual({ value: 'apikey', stale: false });
  });

  test('a different password does not', () => {
    const a = createKeyRing({ databaseUrl: DB('obelisk') });
    const b = createKeyRing({ databaseUrl: DB('obelisk', 'pw-2') });
    expect(b.open(a.seal('apikey', ME), ME)).toBeNull();
  });

  test('url-encoded passwords are read as the password itself', () => {
    expect(databasePasswordMaterial('postgres://u:p%40ss@h/db')).toBe('db-password:p@ss');
    expect(databasePasswordMaterial('postgres://u@h/db')).toBe('db-url:postgres://u@h/db');
  });
});

describe('moving between keys', () => {
  test('setting SECRET_KEY later still opens password-sealed values, marked stale', () => {
    const before = createKeyRing({ databaseUrl: DB('obelisk') });
    const after = createKeyRing({ secretKey: 's'.repeat(44), databaseUrl: DB('obelisk') });
    expect(after.source).toBe('secret-key');
    const sealed = before.seal('apikey', ME);
    expect(after.open(sealed, ME)).toEqual({ value: 'apikey', stale: true });
    expect(after.open(after.seal('apikey', ME), ME)?.stale).toBe(false);
  });

  test('rotating SECRET_KEY: the old one in SECRET_KEY_PREVIOUS keeps values readable', () => {
    const old = createKeyRing({ secretKey: 'a'.repeat(44), databaseUrl: DB('obelisk') });
    const sealed = old.seal('apikey', ME);
    const rotated = createKeyRing({ secretKey: 'b'.repeat(44), previousSecretKeys: ['a'.repeat(44), ' '], databaseUrl: DB('obelisk') });
    expect(rotated.open(sealed, ME)).toEqual({ value: 'apikey', stale: true });
    const forgot = createKeyRing({ secretKey: 'b'.repeat(44), databaseUrl: DB('obelisk') });
    expect(forgot.open(sealed, ME)).toBeNull();
  });

  test('v1 values open with the material they were sealed with and come back stale', () => {
    const ring = createKeyRing({ databaseUrl: DB('obelisk') });
    expect(ring.open(sealV1('apikey', DB('obelisk')), ME)).toEqual({ value: 'apikey', stale: true });
    const withSecret = createKeyRing({ secretKey: 'k'.repeat(44), databaseUrl: DB('obelisk') });
    expect(withSecret.open(sealV1('apikey', 'k'.repeat(44)), ME)).toEqual({ value: 'apikey', stale: true });
    expect(withSecret.open(sealV1('apikey', DB('obelisk')), ME)).toEqual({ value: 'apikey', stale: true });
    // sealed by a server that used another URL: not ours to open
    expect(ring.open(sealV1('apikey', DB('obelisk_other')), ME)).toBeNull();
  });
});
