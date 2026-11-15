// `npx drizzle-kit generate --config why/shipto/remote/db/drizzle.config.ts` writes the
// migrations in why/shipto/remote/migrations; the service applies them at start
// (dev.ts) or at deploy (`npx drizzle-kit migrate` against Neon).
import {defineConfig} from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './why/shipto/remote/db/schema.ts',
  out: './why/shipto/remote/migrations',
  dbCredentials: {url: process.env.DATABASE_URL ?? 'postgres://localhost/why'},
});
