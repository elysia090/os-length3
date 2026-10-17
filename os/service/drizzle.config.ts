// `npx drizzle-kit generate --config service/drizzle.config.ts` writes the
// migrations in service/migrations; the service applies them at start
// (dev.ts) or at deploy (`npx drizzle-kit migrate` against Neon).
import {defineConfig} from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './service/schema.ts',
  out: './service/migrations',
  dbCredentials: {url: process.env.DATABASE_URL ?? 'postgres://localhost/length3'},
});
