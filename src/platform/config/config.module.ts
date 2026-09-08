import { Global, Module } from '@nestjs/common';
import { type AnyEnv, loadEnv, type ProcessRole } from './env.schema.js';

export const ENV = Symbol('Env');
export const PROCESS_ROLE = Symbol('ProcessRole');

@Global()
@Module({})
export class ConfigModule {
  static forRole(role: ProcessRole) {
    return {
      module: ConfigModule,
      providers: [
        { provide: PROCESS_ROLE, useValue: role },
        { provide: ENV, useValue: loadEnv(role) as AnyEnv },
      ],
      exports: [ENV, PROCESS_ROLE],
    };
  }
}
