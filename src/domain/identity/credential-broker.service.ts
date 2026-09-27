import { Inject, Injectable } from '@nestjs/common';
import { createHmac, randomBytes } from 'node:crypto';
import type { Tx } from '../../platform/persistence/database.js';
import { SECRET_STORE, type SecretStore } from '../ports/secret-store.port.js';
import { PlatformError } from '../errors/platform.errors.js';

export interface MintRequest {
  orgId: string;
  runId: string;
  stepId: string | null;
  workloadIdentityId: string;
  onBehalfOfPrincipalId: string | null;
  audience: string;
  scopes: string[];
  tenantRef: string | null;
  ttlSeconds?: number;
}

export interface MintedCredential {
  grantId: string;
  tokenId: string;
  /** Ready-to-send transport headers. The caller never sees or handles a raw secret. */
  headers: Record<string, string>;
  expiresAt: Date;
}

/**
 * §16.3. Credentials never enter model context and are never ambient service credentials.
 *
 * `credential_grants` records that a token was minted -- audience, scopes, on-behalf-of,
 * jti -- and never the token itself. The audit answers "which human authorized this side
 * effect, through which chain of agents, exercising whose permissions" (§0.1) without
 * the audit trail itself becoming a secret store.
 *
 * Phase 1 mints a locally-signed bearer token. The signing key moves to KMS and the token
 * to a real OIDC exchange in Phase 3; the call site does not change, which is the point
 * of putting this behind a service now rather than reaching for env vars at each tool.
 */
@Injectable()
export class CredentialBroker {
  private readonly signingKey =
    process.env['CREDENTIAL_SIGNING_KEY'] ?? randomBytes(32).toString('hex');

  constructor(@Inject(SECRET_STORE) private readonly secrets: SecretStore) {}

  /**
   * Resolves a model provider's credential and records the grant.
   *
   * Returns the secret to the CALLER (the gateway, which hands it straight to the
   * provider adapter) and never to anything that persists or logs. `credential_grants`
   * gets the audience, the scopes, the on-behalf-of principal and a jti -- never the
   * value. That is what lets an audit answer §0.1's question without the audit itself
   * becoming a secret store.
   *
   * A model marked `external` that resolves to nothing fails HERE, before a request is
   * built, rather than as a 401 halfway through a run.
   */
  async forModel(
    tx: Tx,
    request: Omit<MintRequest, 'scopes'> & { credentialRef: string | null; baseUrl: string | null },
  ): Promise<Record<string, string>> {
    if (!request.credentialRef) return {};

    const resolved = await this.secrets.resolve(request.credentialRef);
    if (!resolved) {
      throw new PlatformError(
        'capability_denied',
        `No secret is configured for credential_ref "${request.credentialRef}"`,
        { credentialRef: request.credentialRef },
      );
    }

    await this.record(tx, {
      ...request,
      scopes: ['model:invoke'],
      tokenId: randomBytes(16).toString('hex'),
      expiresAt: new Date(Date.now() + (request.ttlSeconds ?? 300) * 1000),
    });

    return { ...resolved, ...(request.baseUrl ? { baseUrl: request.baseUrl } : {}) };
  }

  /**
   * A third-party API's OWN credential, for a tool whose template names a `credential_ref`.
   *
   * Sent INSTEAD of the platform token, not beside it: GitHub and its kind read exactly one
   * `Authorization` header, and a platform JWT handed to a third party is a leak with no upside.
   * The grant is recorded exactly as `mint` records one, so the audit trail does not care which
   * kind of credential a call carried.
   *
   * The secret is a bare token (sent as `Authorization: Bearer <token>`) or a JSON object whose
   * `header` and `scheme` override either half, for an API that wants `X-Api-Key: <token>` or
   * `Authorization: token <token>`. A ref that resolves to nothing fails HERE, before a request
   * is built, rather than as a 401 the model then tries to reason about.
   */
  async forTool(
    tx: Tx,
    request: MintRequest & { credentialRef: string },
  ): Promise<MintedCredential> {
    const resolved = await this.secrets.resolve(request.credentialRef);
    const token = resolved?.['apiKey'] ?? resolved?.['token'];
    if (!token) {
      throw new PlatformError(
        'capability_denied',
        `No secret is configured for credential_ref "${request.credentialRef}"`,
        { credentialRef: request.credentialRef },
      );
    }

    const tokenId = randomBytes(16).toString('hex');
    const expiresAt = new Date(Date.now() + (request.ttlSeconds ?? 300) * 1000);
    const grantId = await this.record(tx, { ...request, tokenId, expiresAt });

    const header = (resolved?.['header'] ?? 'authorization').toLowerCase();
    const scheme = resolved?.['scheme'] ?? (header === 'authorization' ? 'Bearer' : '');
    return {
      grantId,
      tokenId,
      headers: { [header]: scheme ? `${scheme} ${token}` : token },
      expiresAt,
    };
  }

  async mint(tx: Tx, request: MintRequest): Promise<MintedCredential> {
    const tokenId = randomBytes(16).toString('hex');
    const ttl = request.ttlSeconds ?? 300;
    const expiresAt = new Date(Date.now() + ttl * 1000);

    const claims = {
      jti: tokenId,
      aud: request.audience,
      sub: request.workloadIdentityId,
      obo: request.onBehalfOfPrincipalId,
      tenant: request.tenantRef,
      scopes: request.scopes,
      exp: Math.floor(expiresAt.getTime() / 1000),
    };
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const signature = createHmac('sha256', this.signingKey).update(payload).digest('base64url');

    const grantId = await this.record(tx, { ...request, tokenId, expiresAt });

    return {
      grantId,
      tokenId,
      headers: {
        authorization: `Bearer ${payload}.${signature}`,
        'x-agent-workload': request.workloadIdentityId,
        ...(request.tenantRef ? { 'x-tenant-ref': request.tenantRef } : {}),
      },
      expiresAt,
    };
  }

  private async record(
    tx: Tx,
    request: MintRequest & { tokenId: string; expiresAt: Date },
  ): Promise<string> {
    const row = await tx
      .insertInto('credential_grants')
      .values({
        org_id: request.orgId,
        run_id: request.runId,
        step_id: request.stepId,
        workload_identity_id: request.workloadIdentityId,
        on_behalf_of_principal_id: request.onBehalfOfPrincipalId,
        audience: request.audience,
        scopes: request.scopes,
        tenant_ref: request.tenantRef,
        token_id: request.tokenId,
        expires_at: request.expiresAt,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }
}
