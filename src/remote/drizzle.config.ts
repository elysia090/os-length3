// `npx drizzle-kit generate --config src/remote/drizzle.config.ts` writes the
// migrations in src/remote/migrations; the service applies them at start
// (dev.ts) or at deploy (`npx drizzle-kit migrate` against Neon).
import {defineConfig} from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/remote/schema.ts',
  out: './src/remote/migrations',
  dbCredentials: {url: process.env.DATABASE_URL ?? 'postgres://localhost/length3'},
});
