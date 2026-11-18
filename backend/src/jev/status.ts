import type { JevStatus } from '@obelisk/core';
import { unseal } from '../common/secret';
import type { UserRow } from '../db/schema';

/** What a stored Jev key is bound to: its owner, so a value copied into another account doesn't open. */
export const jevKeyContext = (userId: string) => `jev-key:${userId}`;

/**
 * What the client may know about a user's Jev connection — never the key itself.
 * A key this server can no longer open (SECRET_KEY changed without SECRET_KEY_PREVIOUS, a database
 * restored from elsewhere) counts as not connected, flagged so the app can ask for it again.
 */
export function jevStatus(u: Pick<UserRow, 'id' | 'jevKey' | 'jevKeyHint' | 'jevAutoApply' | 'jevBaseUrl' | 'jevModel'>): JevStatus {
  const readable = !!u.jevKey && unseal(u.jevKey, jevKeyContext(u.id)) !== null;
  return {
    connected: readable,
    keyUnreadable: !!u.jevKey && !readable,
    hint: u.jevKey ? u.jevKeyHint : null,
    autoApply: u.jevAutoApply,
    baseUrl: u.jevBaseUrl,
    model: u.jevModel,
  };
}
