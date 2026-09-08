import { Injectable, Logger } from '@nestjs/common';
import type { SecretStore } from '../../domain/ports/secret-store.port.js';

/**
 * Environment-backed secret store.
 *
 * A credential_ref of `openai` resolves `MODEL_CREDENTIAL_OPENAI`, which is either a bare
 * key or a JSON object for providers needing more than one field:
 *
 *   MODEL_CREDENTIAL_OPENAI=sk-...
 *   MODEL_CREDENTIAL_BEDROCK={"accessKeyId":"...","secretAccessKey":"...","region":"us-east-1"}
 *
 * Deliberately not reading process.env at the provider: setting vendor keys onto the
 * environment around a call and restoring them afterwards is how one tenant's key ends up
 * in another tenant's request under concurrency -- whichever run wrote last wins for both.
 */
@Injectable()
export class EnvSecretStore implements SecretStore {
  readonly id = 'env';
  private readonly log = new Logger(EnvSecretStore.name);

  async resolve(ref: string): Promise<Record<string, string> | null> {
    const normalised = ref.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
    const conventional = `MODEL_CREDENTIAL_${normalised}`;

    // The convention first; then the ref treated as a literal variable name. The fallback
    // exists so a deployment with an established env convention can be adopted without
    // copying secrets into a second variable -- two copies of a key is two places to
    // rotate and one place to forget.
    const key = process.env[conventional] !== undefined ? conventional : normalised;
    const raw = process.env[key];

    if (!raw) {
      // The name, never a value. A miss is a configuration error worth seeing.
      this.log.warn(`no secret for credential_ref "${ref}" (tried ${conventional}, ${normalised})`);
      return null;
    }
    if (raw.trimStart().startsWith('{')) {
      try {
        return JSON.parse(raw) as Record<string, string>;
      } catch {
        throw new Error(`Secret ${key} looks like JSON but does not parse`);
      }
    }
    return { apiKey: raw };
  }
}
