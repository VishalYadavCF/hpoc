// Prisma 7 configuration.
//
// Connection URLs moved out of schema.prisma in v7 and live here. Note the
// asymmetry this creates: the CLI (migrate, db pull, studio) reads the URL
// from this file, while PrismaClient at runtime gets its connection from the
// driver adapter constructed in src/prisma/prisma.service.ts. Both read
// DATABASE_URL, so they agree - but they are two separate code paths.
import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: env('DATABASE_URL'),
    // `migrate dev` creates and drops this database to diff the schema.
    // It must not point at DATABASE_URL.
    shadowDatabaseUrl: env('SHADOW_DATABASE_URL'),
  },
});
