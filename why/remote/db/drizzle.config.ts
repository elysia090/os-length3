// `npx drizzle-kit generate --config why/remote/db/drizzle.config.ts` writes the
// migrations in why/remote/migrations; the service applies them at start
// (dev.ts) or at deploy (`npx drizzle-kit migrate` against Neon).
import {defineConfig} from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './why/remote/db/schema.ts',
  out: './why/remote/migrations',
  dbCredentials: {url: process.env.DATABASE_URL ?? 'postgres://localhost/why'},
});
