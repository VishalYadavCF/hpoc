import { Module } from '@nestjs/common';
import { EnvSecretStore } from './secrets/env.secret-store.js';
import { SECRET_STORE } from '../domain/ports/secret-store.port.js';

@Module({
  providers: [EnvSecretStore, { provide: SECRET_STORE, useExisting: EnvSecretStore }],
  exports: [SECRET_STORE],
})
export class SecretAdaptersModule {}
