import { describe, expect, test } from 'bun:test';
import { migrationLockedSecrets } from '@obelisk/core';
import { lockSecrets, unlockSecrets } from '../src/migration/secrets';

const EXPORT = '00000000-0000-4000-8000-000000000001';
const DATA = { jevKey: 'sk-jev-0123456789abcdef', webhooks: { '00000000-0000-4000-8000-000000000002': 'whsec_abcdefghijklmnop' } };
// The smallest cost the bundle schema accepts keeps the tests quick.
const FAST = { N: 2 ** 14, r: 8, p: 1 };

describe('passphrase-locked secrets', () => {
  test('round-trips with the right passphrase and hides the values', async () => {
    const locked = await lockSecrets(DATA, '맞는 암호 1234', EXPORT, FAST);
    expect(migrationLockedSecrets.safeParse(locked).success).toBe(true);
    expect(JSON.stringify(locked)).not.toContain('sk-jev');
    expect(JSON.stringify(locked)).not.toContain('whsec_');
    expect(await unlockSecrets(locked, '맞는 암호 1234', EXPORT)).toEqual(DATA);
  });

  test('the default cost is the documented one', async () => {
    const locked = await lockSecrets(DATA, 'correct horse', EXPORT);
    expect([locked.N, locked.r, locked.p]).toEqual([2 ** 15, 8, 1]);
    expect(await unlockSecrets(locked, 'correct horse', EXPORT)).toEqual(DATA);
  });

  test('a fresh salt and IV every time', async () => {
    const a = await lockSecrets(DATA, 'correct horse', EXPORT, FAST);
    const b = await lockSecrets(DATA, 'correct horse', EXPORT, FAST);
    expect(a.salt).not.toBe(b.salt);
    expect(a.iv).not.toBe(b.iv);
    expect(a.body).not.toBe(b.body);
  });

  test('a wrong passphrase opens nothing', async () => {
    const locked = await lockSecrets(DATA, 'correct horse', EXPORT, FAST);
    expect(await unlockSecrets(locked, 'correct horse ', EXPORT)).toBeNull();
    expect(await unlockSecrets(locked, '', EXPORT)).toBeNull();
  });

  test('tampering or moving the block into another export is refused', async () => {
    const locked = await lockSecrets(DATA, 'correct horse', EXPORT, FAST);
    const flip = (s: string) => {
      const buf = Buffer.from(s, 'base64url');
      buf[0] = buf[0]! ^ 1;
      return buf.toString('base64url');
    };
    expect(await unlockSecrets({ ...locked, body: flip(locked.body) }, 'correct horse', EXPORT)).toBeNull();
    expect(await unlockSecrets({ ...locked, tag: flip(locked.tag) }, 'correct horse', EXPORT)).toBeNull();
    expect(await unlockSecrets({ ...locked, iv: flip(locked.iv) }, 'correct horse', EXPORT)).toBeNull();
    expect(await unlockSecrets({ ...locked, salt: flip(locked.salt) }, 'correct horse', EXPORT)).toBeNull();
    expect(await unlockSecrets({ ...locked, tag: locked.tag.slice(0, 8) }, 'correct horse', EXPORT)).toBeNull();
    expect(await unlockSecrets(locked, 'correct horse', '00000000-0000-4000-8000-000000000009')).toBeNull();
  });
});
