/**
 * DI tokens live in a leaf module with no imports of their own.
 *
 * Putting them in persistence.module.ts creates a cycle -- the module imports the
 * services, the services import the tokens back -- which under ESM is a TDZ error at
 * boot rather than a warning at build time.
 */
export const DB = Symbol('Db');
export const POOL = Symbol('Pool');
export const LISTENER_POOL = Symbol('ListenerPool');
