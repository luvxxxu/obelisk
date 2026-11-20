import { migrationSecretsData, type MigrationLockedSecrets, type MigrationSecrets } from '@obelisk/core';
import { createCipheriv, createDecipheriv, randomBytes, scrypt, type ScryptOptions } from 'node:crypto';

/**
 * Secrets in an export file (the Jev key, webhook signing secrets) travel only under a passphrase
 * the exporter chooses: scrypt turns it into a 256-bit key, AES-256-GCM seals the JSON, and the
 * export id is bound in as associated data so a locked block can't be moved into another file.
 */

export const SCRYPT_PARAMS = { N: 2 ** 15, r: 8, p: 1 } as const;

const aad = (exportId: string) => Buffer.from(`obelisk-export:${exportId}`, 'utf8');

function deriveKey(passphrase: string, salt: Buffer, params: { N: number; r: number; p: number }): Promise<Buffer> {
  const options: ScryptOptions = { ...params, maxmem: 128 * params.N * params.r + 16 * 1024 * 1024 };
  return new Promise((resolve, reject) =>
    scrypt(passphrase.normalize('NFC'), salt, 32, options, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

export async function lockSecrets(
  data: MigrationSecrets,
  passphrase: string,
  exportId: string,
  params: { N: number; r: number; p: number } = SCRYPT_PARAMS,
): Promise<MigrationLockedSecrets> {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await deriveKey(passphrase, salt, params);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad(exportId));
  const body = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]);
  return {
    mode: 'locked',
    kdf: 'scrypt',
    ...params,
    salt: salt.toString('base64url'),
    iv: iv.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
    body: body.toString('base64url'),
  };
}

/** null when the passphrase is wrong or the block was changed (GCM can't tell the two apart). */
export async function unlockSecrets(locked: MigrationLockedSecrets, passphrase: string, exportId: string): Promise<MigrationSecrets | null> {
  let plain: string;
  // A short tag would weaken GCM's check: only the full 16 bytes count.
  if (Buffer.from(locked.tag, 'base64url').length !== 16 || Buffer.from(locked.iv, 'base64url').length !== 12) return null;
  try {
    const key = await deriveKey(passphrase, Buffer.from(locked.salt, 'base64url'), locked);
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(locked.iv, 'base64url'));
    decipher.setAAD(aad(exportId));
    decipher.setAuthTag(Buffer.from(locked.tag, 'base64url'));
    plain = Buffer.concat([decipher.update(Buffer.from(locked.body, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
  try {
    const parsed = migrationSecretsData.safeParse(JSON.parse(plain));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
