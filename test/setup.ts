import { readFileSync } from 'node:fs';

// Load .env without a dependency: the app is started with --env-file, tests are not.
for (const line of readFileSync('.env', 'utf8').split('\n')) {
  const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (!match) continue;
  const [, key, raw] = match;
  process.env[key!] ??= raw!.replace(/^"(.*)"$/, '$1');
}
