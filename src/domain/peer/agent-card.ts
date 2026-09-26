import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';

/**
 * The A2A Agent Card (§13.6).
 *
 * Deliberately narrow. A card advertises what a peer can be ASKED, never how it works:
 * no model ref, no tool endpoints, no prompt, no sub-agent names. Those are the caller's
 * business only if the caller is inside the trust domain, and a peer by definition is not
 * (§13.3). Leaking them here would turn a discovery document into a reconnaissance one.
 */
export interface AgentCard {
  protocolVersion: string;
  name: string;
  /** Required by the A2A schema; a2a-java rejects a card without one. */
  description: string;
  /** Where a remote caller sends JSON-RPC. Absent for a card describing a local peer. */
  url: string | null;
  /** `url` is required alongside `organization` by the A2A schema and by a2a-java. */
  provider: { organization: string; url: string };
  version: string;
  capabilities: {
    streaming: boolean;
    pushNotifications: boolean;
    stateTransitionHistory: boolean;
  };
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: { id: string; name: string; description: string; tags: string[] }[];
}

export interface SignedAgentCard extends AgentCard {
  signature: { alg: 'Ed25519'; keyId: string; value: string };
}

/**
 * §13.4's three streaming guarantees, asserted as capabilities rather than aspirations.
 *
 * All three are properties the event log already has: per-run sequence numbers give every
 * subscriber the same events in the same order, streams are independent readers of that
 * log, and history is what `Last-Event-ID` replays. That is why the card can claim them
 * without any A2A-specific machinery existing.
 */
export const A2A_CAPABILITIES = {
  streaming: true,
  pushNotifications: true,
  stateTransitionHistory: true,
} as const;

export const A2A_PROTOCOL_VERSION = '0.3.0';

/**
 * Canonical JSON: object keys sorted at every depth, no incidental whitespace.
 *
 * A signature over `JSON.stringify` is a signature over V8's key insertion order. Two
 * runtimes that build the same card differently produce different bytes, and the
 * verification fails for a reason nobody can see by reading either card.
 */
export function canonicalise(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalise).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalise(v)}`).join(',')}}`;
}

/** A stable id for a key, so a card names which key signed it without carrying the key. */
export function keyId(publicKeyPem: string): string {
  return createHash('sha256').update(publicKeyPem).digest('hex').slice(0, 16);
}

export function signCard(card: AgentCard, privateKeyPem: string): SignedAgentCard {
  const key = createPrivateKey(privateKeyPem);
  const pub = createPublicKey(key).export({ type: 'spki', format: 'pem' }).toString();
  // Ed25519 signs the message directly -- no digest argument, which is why the first
  // parameter is null rather than 'sha256'.
  const value = sign(null, Buffer.from(canonicalise(card), 'utf8'), key).toString('base64');
  return { ...card, signature: { alg: 'Ed25519', keyId: keyId(pub), value } };
}

/**
 * Verifies a signed card against a key supplied SEPARATELY.
 *
 * The key is a parameter and never read from the card: a document carrying the key that
 * verifies it proves only that its author owns a keypair, which is not a claim worth
 * checking. The registry holds the key it expects for a peer, out of band.
 */
export function verifyCard(
  signed: SignedAgentCard,
  publicKeyPem: string,
): { valid: boolean; reason?: string } {
  if (signed.signature?.alg !== 'Ed25519') {
    return { valid: false, reason: `Unsupported signature algorithm ${signed.signature?.alg}` };
  }
  const key = createPublicKey(publicKeyPem);
  const expected = keyId(key.export({ type: 'spki', format: 'pem' }).toString());
  if (signed.signature.keyId !== expected) {
    // Refused rather than attempted: verifying against a key the card did not claim would
    // succeed only by coincidence, and failing here says which key was expected.
    return { valid: false, reason: `Card was signed by key ${signed.signature.keyId}, not ${expected}` };
  }

  const { signature: _signature, ...card } = signed;
  const ok = verify(
    null,
    Buffer.from(canonicalise(card as AgentCard), 'utf8'),
    key,
    Buffer.from(signed.signature.value, 'base64'),
  );
  return ok ? { valid: true } : { valid: false, reason: 'Signature does not match card contents' };
}
