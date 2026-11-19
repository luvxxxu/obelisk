import { describe, expect, test } from 'bun:test';
import { defaultMailFrom } from '../src/config';

describe('defaultMailFrom', () => {
  const site = 'https://obelisk.example.com';

  test('a mailbox SMTP login is the sender', () => {
    expect(defaultMailFrom('smtps://someone@gmail.com:apppassword@smtp.gmail.com:465', site)).toBe('Obelisk <someone@gmail.com>');
    expect(defaultMailFrom('smtp://someone%40naver.com:apppassword@smtp.naver.com:587', site)).toBe('Obelisk <someone@naver.com>');
  });

  test('a login that is not an address falls back to no-reply on the public host', () => {
    expect(defaultMailFrom('smtps://apikey:secret@smtp.example.net:465', site)).toBe('Obelisk <no-reply@obelisk.example.com>');
    expect(defaultMailFrom(null, site)).toBe('Obelisk <no-reply@obelisk.example.com>');
    expect(defaultMailFrom('not a url', site)).toBe('Obelisk <no-reply@obelisk.example.com>');
  });
});
