import { defineConfig } from "prisma/config";

/**
 * Prisma CLI configuration.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Replaces the `prisma` block in package.json, which Prisma 6.19 deprecates
 * and Prisma 7 removes. The warning printed on every single Prisma command,
 * including `npm run build`.
 *
 * ── The one line that is not optional ────────────────────────────────────
 * `process.loadEnvFile()`.
 *
 * The moment a Prisma config file exists, the CLI STOPS loading `.env` by
 * itself and says so: "Prisma config detected, skipping environment variable
 * loading." Without the call below, `env("DATABASE_URL")` in the schema
 * resolves to nothing and EVERY Prisma command fails with P1012 — generate,
 * migrate dev, migrate deploy, studio, db:test, and the production build.
 *
 * That is not a theory. Adding an empty config file and running
 * `prisma validate` fails immediately; adding this line makes it pass.
 *
 * ── Why this is safe for db:test, which is the dangerous case ────────────
 * `scripts/test-db.mjs` runs `prisma migrate deploy` in a CHILD PROCESS with
 * DATABASE_URL and DIRECT_DATABASE_URL already pointed at `ontrack_test`. If
 * loading `.env` here OVERWROTE those, migrations would silently be applied to
 * the DEVELOPMENT database instead — the exact accident that script's
 * refuse-to-run interlock exists to prevent, and it would slip past it,
 * because the interlock checks the URLs it passes down rather than the ones
 * Prisma ends up using.
 *
 * It does not overwrite. `process.loadEnvFile()` follows Node's `--env-file`
 * semantics: a variable already present in the environment wins. Verified
 * against a sentinel value before this file was written, not assumed.
 *
 * ── Node floor ──────────────────────────────────────────────────────────
 * `process.loadEnvFile()` arrived in Node 20.12, so `engines.node` moved from
 * >=20.11.0 to >=20.12.0 in the same change. The alternative was adding
 * `dotenv` back as a dependency, one commit after removing four that nothing
 * used; a three-week-wide version floor is the cheaper price.
 * ─────────────────────────────────────────────────────────────────────────
 */
process.loadEnvFile();

export default defineConfig({
  // Stated rather than left to convention. The CLI would find this path on its
  // own, but the config file is where someone now looks to answer "which
  // schema?", and an empty answer there is worse than a redundant one.
  schema: "prisma/schema.prisma",

  migrations: {
    /**
     * Moved from `package.json#prisma.seed`, and note it now lives UNDER
     * `migrations` rather than at the top level.
     *
     * Nothing in package.json's scripts uses this: `npm run db:seed` calls
     * `tsx prisma/seed.ts` directly. It is carried across because the CLI
     * itself reads it — `prisma migrate reset`, and `prisma migrate dev` when
     * a reset is required, reseed through this. Dropping the key would have
     * left a developer with an empty database and no error to explain it.
     */
    seed: "tsx prisma/seed.ts",
  },
});
