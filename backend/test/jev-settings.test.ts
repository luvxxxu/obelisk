import 'reflect-metadata';
import { afterEach, describe, expect, test } from 'bun:test';
import { HttpException } from '@nestjs/common';
import { cloudflareJevUrl } from '@obelisk/core';
import { seal } from '../src/common/secret';
import { config } from '../src/config';
import type { UserRow } from '../src/db/schema';
import type { Transport } from '../src/jev/jev.client';
import { JevService } from '../src/jev/jev.service';
import { jevKeyContext } from '../src/jev/status';

const ACCOUNT = '0123456789abcdef0123456789abcdef';
const TYPESAFE_KEY = 'apikey_typesafe_0000000001';
const CF_TOKEN = 'cf_token_000000000000000000000000000001';

const userRow = (extra: Partial<UserRow> = {}) =>
  ({
    id: 'user-1',
    email: 'me@example.com',
    name: 'Me',
    passwordHash: '',
    timezone: 'Asia/Seoul',
    defaultWorkspaceId: null,
    jevKey: null,
    jevKeyHint: null,
    jevBaseUrl: null,
    jevModel: null,
    jevAutoApply: false,
    homeLayout: null,
    createdAt: new Date(),
    ...extra,
  }) as UserRow;

const ok = () => new Response(JSON.stringify({ answers: { ok: { type: 'noul', noul: 0.9 } } }), { status: 200 });

/** A service whose database only records the one `update users set …` it is asked to do. */
function setup(user: UserRow) {
  const calls: { url: string; auth: string; model: string }[] = [];
  const saved: Partial<UserRow>[] = [];
  const db = {
    update: () => ({
      set: (patch: Partial<UserRow>) => ({
        where: () => ({
          returning: async () => {
            saved.push(patch);
            return [{ ...user, ...patch }];
          },
        }),
      }),
    }),
  };
  const service = new JevService(db as never, {} as never, {} as never);
  service.transport = (async (url, init) => {
    calls.push({ url, auth: (init.headers as Record<string, string>).Authorization!, model: JSON.parse(String(init.body)).model });
    return ok();
  }) satisfies Transport;
  return { service, calls, saved };
}

const allowPrivate = config.jevAllowPrivate;
afterEach(() => {
  config.jevAllowPrivate = allowPrivate;
});

describe('Jev settings: base URL and model', () => {
  test('connects to OpenRouter with its own key and remembers the base URL and model', async () => {
    const { service, calls, saved } = setup(userRow());
    const { jev } = await service.updateSettings(userRow(), {
      apiKey: 'sk-or-v1-0000000000000001',
      baseUrl: 'https://openrouter.ai/api/v1/',
      model: '~typesafe/jev-latest',
    });
    expect(calls).toEqual([{ url: 'https://openrouter.ai/api/v1/systemone', auth: 'Bearer sk-or-v1-0000000000000001', model: '~typesafe/jev-latest' }]);
    expect(saved[0]).toMatchObject({ jevBaseUrl: 'https://openrouter.ai/api/v1', jevModel: '~typesafe/jev-latest', jevKeyHint: '0001' });
    expect(jev).toMatchObject({ connected: true, baseUrl: 'https://openrouter.ai/api/v1', model: '~typesafe/jev-latest' });
  });

  test("TypeSafe's own base URL is stored as the default (null)", async () => {
    const me = userRow({
      jevKey: seal('sk-or-v1-0000000000000001', jevKeyContext('user-1')),
      jevBaseUrl: 'https://openrouter.ai/api/v1',
      jevModel: '~typesafe/jev-latest',
    });
    const { service, calls, saved } = setup(me);
    await service.updateSettings(me, { apiKey: TYPESAFE_KEY, baseUrl: 'https://api.typesafe.ai/v1/systemone', model: null });
    expect(calls[0]).toMatchObject({ url: 'https://api.typesafe.ai/v1/systemone', auth: `Bearer ${TYPESAFE_KEY}`, model: 'jev-latest' });
    expect(saved[0]).toMatchObject({ jevBaseUrl: null, jevModel: null });
  });

  test('a stored key never follows the URL to another host', async () => {
    const me = userRow({ jevKey: seal(TYPESAFE_KEY, jevKeyContext('user-1')), jevKeyHint: '0001' });
    const { service, calls, saved } = setup(me);
    const err = await service.updateSettings(me, { baseUrl: 'https://openrouter.ai/api/v1', model: '~typesafe/jev-latest' }).catch((e) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(400);
    expect(calls).toEqual([]);
    expect(saved).toEqual([]);
  });

  test('on the same host the model changes without the key, checked once with the stored key', async () => {
    const me = userRow({
      jevKey: seal(CF_TOKEN, jevKeyContext('user-1')),
      jevKeyHint: '0001',
      jevBaseUrl: cloudflareJevUrl(ACCOUNT, 'clef'),
      jevModel: 'clef',
    });
    const { service, calls, saved } = setup(me);
    const { jev } = await service.updateSettings(me, { baseUrl: cloudflareJevUrl(ACCOUNT, 'clef-flash'), model: 'clef-flash' });
    expect(calls).toEqual([{ url: cloudflareJevUrl(ACCOUNT, 'clef-flash'), auth: `Bearer ${CF_TOKEN}`, model: 'clef-flash' }]);
    expect(saved[0]).toEqual({ jevBaseUrl: cloudflareJevUrl(ACCOUNT, 'clef-flash'), jevModel: 'clef-flash' });
    expect(jev.model).toBe('clef-flash');
  });

  test('a custom base URL needs a model', async () => {
    const { service, calls } = setup(userRow());
    const err = await service.updateSettings(userRow(), { apiKey: 'k'.repeat(20), baseUrl: 'https://decide.example.com/v1' }).catch((e) => e);
    expect((err as HttpException).getStatus()).toBe(400);
    expect(calls).toEqual([]);
  });

  test("in production a base URL can't point at this server's network or plain http", async () => {
    config.jevAllowPrivate = false;
    const { service, calls } = setup(userRow());
    for (const baseUrl of ['https://127.0.0.1:5432/v1', 'https://169.254.169.254/latest', 'https://db.internal/v1', 'http://decide.example.com/v1']) {
      const err = await service.updateSettings(userRow(), { apiKey: 'k'.repeat(20), baseUrl, model: 'm' }).catch((e) => e);
      expect(err).toBeInstanceOf(HttpException);
      expect((err as HttpException).getStatus()).toBe(400);
    }
    expect(calls).toEqual([]);
  });

  test('disconnecting forgets the service too', async () => {
    const me = userRow({ jevKey: seal(CF_TOKEN, jevKeyContext('user-1')), jevBaseUrl: cloudflareJevUrl(ACCOUNT, 'clef'), jevModel: 'clef' });
    const { service, saved } = setup(me);
    const { jev } = await service.updateSettings(me, { apiKey: null });
    expect(saved[0]).toEqual({ jevKey: null, jevKeyHint: null, jevBaseUrl: null, jevModel: null });
    expect(jev).toMatchObject({ connected: false, baseUrl: null, model: null });
  });
});
