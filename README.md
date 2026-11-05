# NexLiga

NexLiga is a home for community football leagues: public standings, full home-and-away fixtures, match centres, club squads, and matchday updates. League hosting is the core product; FairDraft and the other matchday tools are companion products.

## Run locally

Requires Node.js 22.5 or newer, npm, and Docker Desktop. The dev workflow uses an isolated PostgreSQL database on your computer; it does not use the hosted database configured in `.env`.

```powershell
npm install
Copy-Item .env.local.example .env.local
npm run db:local:up
npm run dev
```

Open `http://127.0.0.1:4173`. The local PostgreSQL data persists in a Docker volume. Stop the database with `npm run db:local:down`; this keeps the volume and its data for the next run. `npm run dev` requires `.env.local` and checks that the database host is local before connecting.

The app seeds a public Harbour Sunday League in an empty non-production database. Supabase Storage is not configured in the local template, so image uploads are unavailable in this local workflow. Production deployment settings remain in `.env` and `render.yaml`.

## Deploy to Render and Supabase

The repository includes a Render Blueprint in `render.yaml`. Supabase supplies PostgreSQL and image storage; Render runs the long-lived Node server. The Render free web service can sleep when idle, so the first request after inactivity may be slow. Supabase free projects may also pause under their current plan limits.

1. **Create a Supabase project.** Choose a region where you intend to run Render. In **Connect → Database**, copy a PostgreSQL connection string. Use the Session pooler if direct IPv6 connectivity is not available; retain the SSL requirement in the connection string.
2. **Back up the current local data before importing.** Stop the local app so SQLite is not being written. Make a separate copy of the entire `data/` directory (including the database, any SQLite `-wal`/`-shm` sidecars, and `uploads/`), and keep the originals unchanged.
3. **Preview the migration locally.** From the repository root, run `npm run migrate:dry-run`. This checks SQLite integrity and foreign keys, verifies referenced images, and reports what would be copied. Dry-run does not require Supabase credentials and does not change either database.
4. **Apply the versioned schema and import into the empty Supabase database.** Fill in the three required values in your local `.env`, then run `npm run migrate:apply`. This applies pending numbered SQL migrations, creates the public image bucket, copies records and referenced images, and refuses to import into a database that already contains application records. The same source snapshot is recognized on a repeat run. Do not run this against a database containing data you need to keep.
5. **Create the Render service after importing.** Push this repository to GitHub, create a new Blueprint in Render, and select the repository. Render reads `render.yaml`; the production app will not seed demo data into your imported database.
6. **Configure required Render environment variables.**
   - `DATABASE_URL`: the Supabase PostgreSQL connection string.
   - `SUPABASE_URL`: the project URL, such as `https://your-project.supabase.co`.
   - `SUPABASE_SERVICE_ROLE_KEY`: the Supabase service-role key. Treat it as a secret.
   - `NODE_ENV`: `production` (set in the Blueprint).
   - `SUPABASE_STORAGE_BUCKET` is optional; the default is `nexliga-media`.
7. **Verify the live service.** Wait for the Render deploy to finish, open the Render URL, and check `/api/health`. Verify league counts, images, standings, login, and manager-only edits. Add SMTP and Google OAuth settings only if you want password recovery and Google sign-in enabled.

The migration preserves accounts and their existing scrypt password hashes, so password users can sign in with their existing credentials. Active sessions and password-reset tokens are deliberately not copied; everyone must sign in again after cutover, and any pending reset link expires with the old deployment. The migration utility reports a deterministic source hash and row counts; keep a copy of that output with your backup.

Optional authentication and email settings:

- `GOOGLE_CLIENT_ID` enables Google sign-in. Configure the OAuth client for the deployed domain.
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, and `SMTP_FROM` enable password-reset email.
- Set `APP_URL` to the final deployed HTTPS address if enabling password-reset email.

Never paste database URLs, service-role keys, SMTP passwords, or OAuth client secrets into chat or source files. Enter them only into the local shell or the provider's secret environment-variable settings.

## Data migration commands

```sh
npm run db:migrate
npm run migrate:dry-run
npm run migrate:apply
```

`db:migrate` applies pending numbered scripts in `db/migrations/` and records their names and checksums in `schema_migrations`. Do not edit a migration after it has been applied; add a new numbered migration for later schema changes.

`SQLITE_PATH` can point the migration utility at a different SQLite source file. Referenced local images are read from `data/uploads/`. The utility intentionally excludes active sessions and password-reset tokens, and does not delete or alter the SQLite source.

## Pages

- `/` - NexLiga home, focused on league hosting and discovery
- `/leagues.html` - discover leagues, create a league, and view your own leagues
- `/leagues/:slug` - public league page or creator workspace
- `/products/live-draw.html` - FairDraft team draw
- `/products/fixtures.html` - standalone round-robin fixture generator
- `/products/verifier.html` - independent draw verification

## Ownership and visibility

The account that creates a league becomes its sole manager. The server checks that ownership before accepting score changes, league settings, new clubs, fixtures, or deletion. A signed-in user who is not the creator receives a `403` response; visitors can only read league data.

League managers can choose public, unlisted, or private visibility. Public leagues appear in discovery. Unlisted leagues are viewable by their direct URL. Private leagues are available only to their creator. Each fixture opens a match centre; only its creator can change the score, date, kickoff, venue, status, or goal events. The creator can manage club squads, and new seasons receive a complete home-and-away fixture list.

League creators can display a community partner and receive sponsorship enquiries. Only the creator can view enquiry contact details and mark an enquiry as contacted. Enquiries are stored in PostgreSQL; outbound sponsor notifications are not configured.

## Companion products

The Products menu links to FairDraft (balanced team draws), Fixture Planner (standalone round-robin schedules), and Draw Verifier (independent draw verification). These browser-side tools are separate from league accounts.

## Security and operations

- Passwords use salted scrypt hashes; session bearer tokens are stored only as SHA-256 hashes. Session cookies are HttpOnly and SameSite=Strict; production enables the Secure flag.
- The app checks same-origin writes, limits request sizes, throttles authentication attempts, and sends standard browser security headers.
- Supabase tables have row-level security enabled without public client policies. The server connects with `DATABASE_URL`; keep database access and the service-role storage key server-side.
- Supabase Storage contains public league/team/player images. The server creates the bucket if it does not exist and rejects an existing private bucket.
- Back up the Supabase database and Storage objects independently. A free-tier service is not a substitute for backups.
- League managers record their own scores; public league pages refresh updates every 20 seconds. Automated professional fixtures and scores require a licensed sports-data provider.
