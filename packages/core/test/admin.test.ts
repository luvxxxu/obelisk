import { describe, expect, test } from 'bun:test';
import { describeAdminAction, emailDomainAllowed, updateServerSettingsInput } from '../src';

describe('emailDomainAllowed', () => {
  test('an empty list lets every address through', () => {
    expect(emailDomainAllowed('a@anything.dev', [])).toBe(true);
  });

  test('only the listed domains, compared without case', () => {
    expect(emailDomainAllowed('kim@company.com', ['company.com'])).toBe(true);
    expect(emailDomainAllowed('kim@Company.COM', ['company.com'])).toBe(true);
    expect(emailDomainAllowed('kim@gmail.com', ['company.com', 'example.org'])).toBe(false);
  });

  test('a subdomain or a look-alike is a different domain', () => {
    expect(emailDomainAllowed('kim@mail.company.com', ['company.com'])).toBe(false);
    expect(emailDomainAllowed('kim@evilcompany.com', ['company.com'])).toBe(false);
    expect(emailDomainAllowed('company.com@gmail.com', ['company.com'])).toBe(false);
  });
});

describe('updateServerSettingsInput', () => {
  test('domains are cleaned: "@Company.com " → "company.com"', () => {
    const r = updateServerSettingsInput.parse({ allowedEmailDomains: ['@Company.com ', 'example.org'] });
    expect(r.allowedEmailDomains).toEqual(['company.com', 'example.org']);
  });

  test('anything that is not a plain domain is refused', () => {
    for (const bad of ['company', 'http://company.com', 'a b.com', '*.company.com', 'kim@company.com']) {
      expect(updateServerSettingsInput.safeParse({ allowedEmailDomains: [bad] }).success).toBe(false);
    }
  });

  test('every field is optional, and the mode must be one of the four', () => {
    expect(updateServerSettingsInput.parse({})).toEqual({});
    expect(updateServerSettingsInput.safeParse({ signupMode: 'approval' }).success).toBe(true);
    expect(updateServerSettingsInput.safeParse({ signupMode: 'first' }).success).toBe(false);
  });
});

describe('describeAdminAction', () => {
  test('settings changes read as before → after', () => {
    const line = describeAdminAction({
      action: 'settings.updated',
      data: {
        changes: {
          signupMode: { from: 'open', to: 'approval' },
          allowedEmailDomains: { from: [], to: ['company.com'] },
          orgCreation: { from: 'everyone', to: 'admins' },
        },
      },
    });
    expect(line).toBe('설정 · 가입 열림 → 승인제 · 도메인 제한 없음 → company.com · 조직 만들기 누구나 → 운영자만');
  });

  test('a suspension keeps its note', () => {
    expect(describeAdminAction({ action: 'user.suspended', data: { note: '스팸' } })).toBe('정지했어요 · 스팸');
    expect(describeAdminAction({ action: 'user.suspended', data: {} })).toBe('정지했어요');
  });

  test('an unknown action shows its key rather than nothing', () => {
    expect(describeAdminAction({ action: 'something.new', data: {} })).toBe('something.new');
  });
});
