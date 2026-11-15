/**
 * Minimal OAuth 2.1 authorization server for MCP clients (Claude, ChatGPT, …):
 *  - RFC 8414 metadata, RFC 9728 protected-resource metadata
 *  - RFC 7591 dynamic client registration
 *  - Client ID Metadata Documents (client_id is an https URL)
 *  - Authorization code + PKCE (S256 only), rotating refresh tokens
 */
import { HttpException, Injectable } from '@nestjs/common';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { isIP } from 'node:net';
import { config } from '../config';
import { randomToken, safeEqual, sha256, sha256Base64Url } from '../common/crypto';
import { InjectDb, type Db } from '../db/db.module';
import { oauthClients, oauthCodes, oauthGrants } from '../db/schema';

export const SCOPES = ['obelisk'];

export class OAuthError extends HttpException {
  constructor(error: string, description: string, status = 400) {
    super({ error, error_description: description }, status);
  }
}

interface ClientInfo {
  id: string;
  name: string;
  redirectUris: string[];
  authMethod: 'none' | 'client_secret_post' | 'client_secret_basic';
  secretHash: string | null;
}

export interface AuthorizeParams {
  response_type?: string;
  client_id?: string;
  redirect_uri?: string;
  code_challenge?: string;
  code_challenge_method?: string;
  state?: string;
  scope?: string;
  resource?: string;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

function isAllowedRedirect(uri: string): boolean {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.hash) return false;
  if (u.protocol === 'https:') return true;
  if (u.protocol === 'http:') return LOOPBACK.has(u.hostname);
  // Private-use schemes for native apps (e.g. cursor://, vscode://); never script-ish ones.
  return /^[a-z][a-z0-9+.-]*:$/i.test(u.protocol) && !['javascript:', 'data:', 'file:', 'vbscript:'].includes(u.protocol);
}

function redirectMatches(registered: string[], requested: string): boolean {
  if (registered.includes(requested)) return true;
  // RFC 8252 §7.3: loopback redirects may use any port.
  try {
    const r = new URL(requested);
    if (r.protocol !== 'http:' || !LOOPBACK.has(r.hostname)) return false;
    return registered.some((reg) => {
      const u = new URL(reg);
      return u.protocol === 'http:' && LOOPBACK.has(u.hostname) && u.pathname === r.pathname;
    });
  } catch {
    return false;
  }
}

const cimdCache = new Map<string, { info: ClientInfo; expires: number }>();

@Injectable()
export class OAuthService {
  constructor(@InjectDb() private readonly db: Db) {}

  authorizationServerMetadata() {
    const base = config.publicUrl;
    return {
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/api/oauth/token`,
      registration_endpoint: `${base}/api/oauth/register`,
      revocation_endpoint: `${base}/api/oauth/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
      revocation_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
      scopes_supported: SCOPES,
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
      service_documentation: `${base}/settings/ai`,
    };
  }

  protectedResourceMetadata() {
    return {
      resource: config.mcpUrl,
      authorization_servers: [config.publicUrl],
      scopes_supported: SCOPES,
      bearer_methods_supported: ['header'],
      resource_name: 'Obelisk',
      resource_documentation: `${config.publicUrl}/settings/ai`,
    };
  }

  // ───────────────────────── clients

  async register(body: Record<string, unknown>) {
    const redirectUris = body.redirect_uris;
    if (!Array.isArray(redirectUris) || redirectUris.length === 0 || redirectUris.length > 20) {
      throw new OAuthError('invalid_redirect_uri', 'redirect_uris must be a non-empty array');
    }
    for (const uri of redirectUris) {
      if (typeof uri !== 'string' || !isAllowedRedirect(uri)) {
        throw new OAuthError('invalid_redirect_uri', `redirect_uri not allowed: ${String(uri)}`);
      }
    }
    const requested = typeof body.token_endpoint_auth_method === 'string' ? body.token_endpoint_auth_method : 'none';
    if (!['none', 'client_secret_post', 'client_secret_basic'].includes(requested)) {
      throw new OAuthError('invalid_client_metadata', `Unsupported token_endpoint_auth_method: ${requested}`);
    }
    const name =
      typeof body.client_name === 'string' && body.client_name.trim()
        ? body.client_name.trim().slice(0, 100)
        : 'MCP client';
    const clientId = randomToken('oc', 16);
    const secret = requested === 'none' ? null : randomToken('ocs', 32);
    await this.db.insert(oauthClients).values({
      id: clientId,
      name,
      redirectUris: redirectUris as string[],
      authMethod: requested,
      secretHash: secret ? sha256(secret) : null,
    });
    return {
      client_id: clientId,
      ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: name,
      redirect_uris: redirectUris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: requested,
      scope: SCOPES.join(' '),
    };
  }

  async getClient(clientId: string | undefined): Promise<ClientInfo> {
    if (!clientId) throw new OAuthError('invalid_request', 'client_id is required');
    if (clientId.startsWith('https://')) return this.fetchClientMetadata(clientId);
    const row = await this.db.query.oauthClients.findFirst({ where: eq(oauthClients.id, clientId) });
    if (!row) throw new OAuthError('invalid_client', 'Unknown client', 401);
    return {
      id: row.id,
      name: row.name,
      redirectUris: row.redirectUris,
      authMethod: row.authMethod as ClientInfo['authMethod'],
      secretHash: row.secretHash,
    };
  }

  /** Client ID Metadata Document: the client_id URL serves its own registration JSON. */
  private async fetchClientMetadata(url: string): Promise<ClientInfo> {
    const cached = cimdCache.get(url);
    if (cached && cached.expires > Date.now()) return cached.info;
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      throw new OAuthError('invalid_client', 'Malformed client_id URL', 401);
    }
    if (u.protocol !== 'https:' || isIP(u.hostname.replace(/^\[|\]$/g, '')) || LOOPBACK.has(u.hostname) || u.hostname.endsWith('.local') || u.pathname === '/') {
      throw new OAuthError('invalid_client', 'client_id URL not allowed', 401);
    }
    let doc: Record<string, unknown>;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: 'error', headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      if (text.length > 64_000) throw new Error('too large');
      doc = JSON.parse(text);
    } catch (e) {
      throw new OAuthError('invalid_client', `Could not load client metadata: ${(e as Error).message}`, 401);
    }
    if (doc.client_id !== url || !Array.isArray(doc.redirect_uris)) {
      throw new OAuthError('invalid_client', 'Client metadata document is invalid', 401);
    }
    const redirectUris = (doc.redirect_uris as unknown[]).filter((r): r is string => typeof r === 'string' && isAllowedRedirect(r));
    const info: ClientInfo = {
      id: url,
      name: typeof doc.client_name === 'string' ? doc.client_name.slice(0, 100) : u.hostname,
      redirectUris,
      authMethod: 'none',
      secretHash: null,
    };
    cimdCache.set(url, { info, expires: Date.now() + 10 * 60_000 });
    return info;
  }

  /** Used by the consent screen before showing anything to the user. */
  async describeRequest(p: AuthorizeParams) {
    const client = await this.getClient(p.client_id);
    if (!p.redirect_uri || !redirectMatches(client.redirectUris, p.redirect_uri)) {
      throw new OAuthError('invalid_request', 'redirect_uri is not registered for this client');
    }
    if (p.response_type !== 'code') throw new OAuthError('unsupported_response_type', 'Only response_type=code is supported');
    if (!p.code_challenge || p.code_challenge_method !== 'S256') {
      throw new OAuthError('invalid_request', 'PKCE with code_challenge_method=S256 is required');
    }
    const host = (() => {
      try {
        return new URL(p.redirect_uri!).host;
      } catch {
        return p.redirect_uri!;
      }
    })();
    return { clientName: client.name, clientId: client.id, redirectHost: host, scope: p.scope || SCOPES.join(' ') };
  }

  async approve(userId: string, p: AuthorizeParams, approved: boolean) {
    const info = await this.describeRequest(p);
    const target = new URL(p.redirect_uri!);
    if (p.state) target.searchParams.set('state', p.state);
    target.searchParams.set('iss', config.publicUrl);
    if (!approved) {
      target.searchParams.set('error', 'access_denied');
      return { redirectTo: target.toString() };
    }
    const code = randomToken('ocd', 32);
    await this.db.insert(oauthCodes).values({
      codeHash: sha256(code),
      clientId: info.clientId,
      clientName: info.clientName,
      userId,
      redirectUri: p.redirect_uri!,
      codeChallenge: p.code_challenge!,
      scope: info.scope,
      resource: p.resource ?? null,
      expiresAt: new Date(Date.now() + 10 * 60_000),
    });
    target.searchParams.set('code', code);
    return { redirectTo: target.toString() };
  }

  // ───────────────────────── tokens

  private async authenticateClient(body: Record<string, string>, authHeader?: string): Promise<ClientInfo> {
    let clientId = body.client_id;
    let secret = body.client_secret;
    if (authHeader?.startsWith('Basic ')) {
      const decoded = Buffer.from(authHeader.slice(6), 'base64').toString();
      const idx = decoded.indexOf(':');
      if (idx < 0) throw new OAuthError('invalid_client', 'Malformed Basic credentials', 401);
      try {
        clientId = decodeURIComponent(decoded.slice(0, idx));
        secret = decodeURIComponent(decoded.slice(idx + 1));
      } catch {
        throw new OAuthError('invalid_client', 'Malformed Basic credentials', 401);
      }
    }
    const client = await this.getClient(clientId);
    if (client.secretHash) {
      if (!secret || !safeEqual(sha256(secret), client.secretHash)) {
        throw new OAuthError('invalid_client', 'Client authentication failed', 401);
      }
    }
    return client;
  }

  private async issue(userId: string, clientId: string, clientName: string, scope: string) {
    const access = randomToken('oat', 32);
    const refresh = randomToken('ort', 32);
    await this.db.insert(oauthGrants).values({
      clientId,
      clientName,
      userId,
      accessHash: sha256(access),
      refreshHash: sha256(refresh),
      scope,
      accessExpiresAt: new Date(Date.now() + config.oauthAccessSeconds * 1000),
      refreshExpiresAt: new Date(Date.now() + config.oauthRefreshDays * 86_400_000),
    });
    return {
      access_token: access,
      token_type: 'Bearer',
      expires_in: config.oauthAccessSeconds,
      refresh_token: refresh,
      scope,
    };
  }

  async token(body: Record<string, string>, authHeader?: string) {
    const grant = body.grant_type;
    if (grant === 'authorization_code') {
      const client = await this.authenticateClient(body, authHeader);
      if (!body.code || !body.code_verifier) throw new OAuthError('invalid_request', 'code and code_verifier are required');
      const row = await this.db.query.oauthCodes.findFirst({ where: eq(oauthCodes.codeHash, sha256(body.code)) });
      if (!row || row.usedAt || row.expiresAt < new Date() || row.clientId !== client.id) {
        throw new OAuthError('invalid_grant', 'Authorization code is invalid or expired');
      }
      if (body.redirect_uri && body.redirect_uri !== row.redirectUri) {
        throw new OAuthError('invalid_grant', 'redirect_uri mismatch');
      }
      if (!safeEqual(sha256Base64Url(body.code_verifier), row.codeChallenge)) {
        throw new OAuthError('invalid_grant', 'PKCE verification failed');
      }
      const used = await this.db
        .update(oauthCodes)
        .set({ usedAt: new Date() })
        .where(and(eq(oauthCodes.codeHash, row.codeHash), isNull(oauthCodes.usedAt)))
        .returning({ h: oauthCodes.codeHash });
      if (!used.length) throw new OAuthError('invalid_grant', 'Authorization code already used');
      return this.issue(row.userId, client.id, row.clientName, row.scope);
    }

    if (grant === 'refresh_token') {
      const client = await this.authenticateClient(body, authHeader);
      if (!body.refresh_token) throw new OAuthError('invalid_request', 'refresh_token is required');
      const row = await this.db.query.oauthGrants.findFirst({
        where: and(
          eq(oauthGrants.refreshHash, sha256(body.refresh_token)),
          isNull(oauthGrants.revokedAt),
          gt(oauthGrants.refreshExpiresAt, new Date()),
        ),
      });
      if (!row || row.clientId !== client.id) throw new OAuthError('invalid_grant', 'Refresh token is invalid or expired');
      // Rotate: the old grant dies, a new one is born.
      await this.db.update(oauthGrants).set({ revokedAt: new Date() }).where(eq(oauthGrants.id, row.id));
      return this.issue(row.userId, row.clientId, row.clientName, row.scope);
    }

    throw new OAuthError('unsupported_grant_type', `Unsupported grant_type: ${grant ?? '(none)'}`);
  }

  async revoke(token: string | undefined) {
    if (!token) return;
    const h = sha256(token);
    await this.db
      .update(oauthGrants)
      .set({ revokedAt: new Date() })
      .where(and(isNull(oauthGrants.revokedAt), token.startsWith('ort_') ? eq(oauthGrants.refreshHash, h) : eq(oauthGrants.accessHash, h)));
  }
}
