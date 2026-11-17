import { describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { assertDeliverable, isPrivateAddress, signBody, UndeliverableError } from '../src/webhooks/net';
import { incomingBody } from '../src/webhooks/body';

describe('isPrivateAddress', () => {
  test.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    'fe80::1',
    'fd00::1',
    'ff02::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '64:ff9b::a00:1',
    '2002:c0a8:0101::1',
    'not-an-ip',
  ])('%s is blocked', (ip) => expect(isPrivateAddress(ip)).toBe(true));

  test.each(['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8', '2002:0808:0808::1'])('%s is public', (ip) =>
    expect(isPrivateAddress(ip)).toBe(false),
  );
});

describe('assertDeliverable', () => {
  const blocked = async (url: string) => {
    try {
      await assertDeliverable(url, false);
    } catch (e) {
      expect(e).toBeInstanceOf(UndeliverableError);
      return (e as UndeliverableError).message;
    }
    throw new Error(`${url} was allowed`);
  };

  test('refuses loopback, private and local names without a DNS lookup', async () => {
    expect(await blocked('http://127.0.0.1:4000/x')).toContain('내부망');
    expect(await blocked('http://[::1]/x')).toContain('내부망');
    expect(await blocked('http://localhost:3000/x')).toContain('내부망');
    expect(await blocked('http://printer.local/x')).toContain('내부망');
    expect(await blocked('http://intranet/x')).toContain('내부망');
    expect(await blocked('https://user:pw@example.com/x')).toContain('비밀번호');
    expect(await blocked('ftp://example.com/x')).toContain('https://');
  });

  test('allows anything well-formed when private targets are allowed', async () => {
    expect((await assertDeliverable('http://127.0.0.1:4000/x', true)).port).toBe('4000');
  });

  test('public IP literals pass', async () => {
    expect((await assertDeliverable('https://8.8.8.8/hook', false)).hostname).toBe('8.8.8.8');
  });
});

describe('signBody', () => {
  test('HMAC-SHA256 over "<timestamp>.<body>"', () => {
    const body = '{"event":"ping"}';
    const expected = createHmac('sha256', 'whsec_test').update(`1700000000.${body}`).digest('hex');
    expect(signBody('whsec_test', 1700000000, body)).toBe(`sha256=${expected}`);
  });
});

describe('incomingBody', () => {
  test('curl -d "text" arrives as a form key; treat it as the text', () => {
    expect(incomingBody('application/x-www-form-urlencoded', { '보고서 내일 !높음': '' })).toBe('보고서 내일 !높음');
    expect(incomingBody('application/x-www-form-urlencoded', { text: '보고서' })).toEqual({ text: '보고서' });
    expect(incomingBody('text/plain', '보고서')).toBe('보고서');
    expect(incomingBody('application/json', { title: 'x' })).toEqual({ title: 'x' });
    expect(incomingBody(undefined, {})).toBe('');
  });
});
