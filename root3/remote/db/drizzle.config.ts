// `npx drizzle-kit generate --config root3/remote/db/drizzle.config.ts` writes the
// migrations in root3/remote/migrations; the service applies them at start
// (dev.ts) or at deploy (`npx drizzle-kit migrate` against Neon).
import {defineConfig} from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './root3/remote/db/schema.ts',
  out: './root3/remote/migrations',
  dbCredentials: {url: process.env.DATABASE_URL ?? 'postgres://localhost/root3'},
});
