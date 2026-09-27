/**
 * Layering rules from ai-docs/plans/lld.md §3, enforced mechanically.
 *
 * Rules are worthless unless a build step fails on them. §2.1's claim that "the core
 * runtime must compile with every protocol adapter removed" is a testable statement, so
 * these test it -- together with `npm run build:core`, which compiles domain + platform
 * alone and turns a leak into a type error.
 */
module.exports = {
  forbidden: [
    {
      name: 'domain-not-depend-on-adapters',
      comment:
        'Domain code may depend on a PORT, never on an adapter. Nest modules that bind ' +
        'ports to adapters live in src/bootstrap/modules, outside the domain band, so ' +
        'there is no exception to this rule.',
      severity: 'error',
      from: { path: '^src/domain' },
      to: { path: '^src/adapters' },
    },
    {
      name: 'domain-not-depend-on-api',
      comment: 'The dependency direction is one-way downward (lld.md §2).',
      severity: 'error',
      from: { path: '^src/domain' },
      to: { path: '^src/(api|worker|scheduler|bootstrap)' },
    },
    {
      name: 'domain-free-of-framework-and-protocol-sdks',
      comment:
        '§0.3: no orchestration-framework or wire-protocol concept may reach the ' +
        'persisted model. Keeping their SDKs out of the domain band is how that stays true.',
      severity: 'error',
      from: { path: '^src/domain' },
      to: { dependencyTypes: ['npm'], path: 'deepagents|@langchain|@modelcontextprotocol' },
    },
    {
      name: 'platform-depends-on-nothing-above-it',
      severity: 'error',
      from: { path: '^src/platform' },
      to: { path: '^src/(domain|adapters|api|worker|scheduler|bootstrap)' },
    },
    {
      name: 'adapters-do-not-import-each-other',
      comment: 'An adapter that needs another is really one adapter.',
      severity: 'error',
      from: { path: '^src/adapters/([^/]+)/' },
      to: { path: '^src/adapters/([^/]+)/', pathNot: '^src/adapters/$1/' },
    },
    { name: 'no-circular', severity: 'error', from: {}, to: { circular: true } },
    { name: 'no-orphans', severity: 'warn', from: { orphan: true, pathNot: '\\.d\\.ts$' }, to: {} },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsConfig: { fileName: 'tsconfig.json' },
    tsPreCompilationDeps: true,
    // src/generated holds the Prisma client, which is generated output rather than
    // source. The runtime uses Kysely; see README for why both exist and which is
    // authoritative.
    exclude: { path: '\\.spec\\.ts$|^src/generated/' },
  },
};
