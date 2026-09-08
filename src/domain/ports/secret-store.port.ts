export const SECRET_STORE = Symbol('SecretStore');

/**
 * Resolves a credential NAME to its value (§16.3).
 *
 * The platform stores names; the store holds values. Phase 1 backs this with environment
 * variables, which is honest for a single-tenant deployment and is the seam where Vault
 * or a cloud secret manager lands without any call site changing.
 *
 * A resolved value must never be logged, persisted, or placed in model context. Only the
 * FACT of resolution is recorded, in `credential_grants`.
 */
export interface SecretStore {
  readonly id: string;
  resolve(ref: string): Promise<Record<string, string> | null>;
}
