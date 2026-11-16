import type { JevStatus } from '@obelisk/core';
import type { UserRow } from '../db/schema';

/** What the client may know about a user's Jev connection — never the key itself. */
export function jevStatus(u: Pick<UserRow, 'jevKey' | 'jevKeyHint' | 'jevAutoApply'>): JevStatus {
  return { connected: !!u.jevKey, hint: u.jevKey ? u.jevKeyHint : null, autoApply: u.jevAutoApply };
}
