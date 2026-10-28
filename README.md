# NexLiga

NexLiga is a home for community football leagues: public standings, full home-and-away fixtures, match centres, club squads, and matchday updates. League hosting is the core product; FairDraft and the other matchday tools are companion products.

## Run the product locally

Requires Node.js 22.5 or newer. SQLite comes from Node's built-in module; npm dependencies provide Google token verification and SMTP email delivery.

```sh
npm install
npm start
```

On Windows, `npm.cmd start` also works.

Open `http://127.0.0.1:4173`. On first start, NexLiga creates `data/fairdraft.sqlite` and seeds a public Harbour Sunday League so the experience has real fixtures, results, and standings to explore. Create your own account to make a league you can manage. There is no shared demo password.

Password recovery and Google sign-in require the corresponding SMTP and Google OAuth environment variables described below. They remain unavailable until configured.

For a persistent container deployment, use `docker compose up --build`; SQLite data is stored in the named `fairdraft-data` volume.

## Pages

- `/` â€” NexLiga home, focused on league hosting and discovery
- `/leagues.html` â€” discover leagues, create a league, and view your own leagues
- `/leagues/:slug` â€” public league page or creator workspace
- `/live-draw.html` â€” provably fair team draw
- `/fixtures.html` â€” seeded round-robin fixture generator
- `/verifier.html` â€” independent draw verification

## Ownership and visibility

The account that creates a league becomes its sole manager. The server checks that ownership before accepting score changes, league settings, new clubs, fixtures, or deletion. A signed-in user who is not the creator receives a `403` response; visitors can only read league data.

League managers can choose public, unlisted, or private visibility. Public leagues appear in discovery. Unlisted leagues are viewable by their direct URL. Private leagues are available only to their creator. League pages show scores, goalscorers, assists, and venues without exposing a public editor activity trail. Each fixture opens a match centre; only its creator can change the score, date, kickoff, venue, status, or goal events. The creator can manage club squads, and new seasons receive a complete home-and-away fixture list.

## Security and deployment notes

- Passwords are stored as salted scrypt hashes; sessions use random bearer tokens stored only as SHA-256 hashes in SQLite.
- Session cookies are HttpOnly and SameSite=Strict. Set `NODE_ENV=production` behind HTTPS to enable the Secure cookie flag.
- The app has a same-origin write check, a request-size limit, basic authentication throttling, and standard browser security headers.
- Use a persistent volume for `FAIRDRAFT_DATA_DIR`; losing that directory loses accounts, sessions, leagues, and match records.
- Configure `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, and `SMTP_FROM` to deliver one-hour password-reset links. Without SMTP, password recovery returns an explicit unavailable error; reset links are never written to server logs.
- Configure `GOOGLE_CLIENT_ID` with a Google OAuth web client ID to enable Google sign-in. The server verifies Google ID tokens and creates or links an account only when Google confirms the email address.
- Set `APP_URL` to the canonical HTTPS origin used in password-reset links.
- For a persistent deployment, place the app behind HTTPS, use managed persistent storage with backups, set an appropriate `HOST`, and monitor the service. The included Compose file is a self-contained demo deployment, not a managed high-availability setup.
- **This version cannot be deployed to Vercel as a production app yet.** The server starts a long-running Node HTTP server and writes SQLite and uploaded media to local disk. Vercel serverless functions do not provide durable local storage. Migrate the API, authentication, database, and uploads before switching production traffic to Vercel.

### Vercel and Firebase migration plan

1. **Back up and inventory the current app.** Stop app writes, create a consistent SQLite backup, and copy the full `FAIRDRAFT_DATA_DIR` including its `uploads` directory. Record table counts and keep the original database untouched until the migration is verified.
2. **Create the Firebase project.** Enable Firebase Authentication with Email/Password and Google providers; add your local and production domains to Authorized domains. Create Firestore in production mode and choose a region close to your users. Create Firebase Storage if league, club, or player images are used.
3. **Choose the Firebase identity transition.** The current app stores scrypt password hashes, not plaintext passwords. Do not copy those hashes into Firestore or a password field. The safest migration is Firebase Auth accounts for new sign-ins and a password-reset/re-registration invitation for existing password users. Preserve each current user ID as `legacyUserId` in the user's Firestore profile so league ownership can be mapped to the new Firebase UID. Google accounts should be linked by verified email after a successful Firebase sign-in.
4. **Define Firestore document paths and access rules.** A practical mapping is `users/{uid}`, `leagues/{slug}`, `leagues/{slug}/teams/{teamId}`, `leagues/{slug}/teams/{teamId}/players/{playerId}`, `leagues/{slug}/matches/{matchId}`, `leagues/{slug}/matches/{matchId}/events/{eventId}`, `leagues/{slug}/matches/{matchId}/squads/{teamId}`, and `leagues/{slug}/partnerLeads/{leadId}`. Preserve existing record IDs and timestamps where possible. Keep owner checks in the trusted API; Firestore rules should also prevent non-owners from writing.
5. **Replace the SQLite server with Vercel-compatible handlers.** Extract each `/api/...` route into serverless functions or a Vercel-compatible framework. Verify Firebase ID tokens on protected requests with Firebase Admin, use Firestore instead of `node:sqlite`, and store uploaded media in Firebase Storage. Do not expose Admin credentials in browser code. Review every existing API route, ownership check, image URL, and live-update flow before removing SQLite.
6. **Build and run an idempotent migration.** Export related SQLite tables into structured JSON while preserving IDs. Import users' profile metadata, leagues, teams, players, fixtures, match events, squads, sponsor enquiries, and image files. Store Firebase UIDs in `ownerId` and retain the old owner IDs as migration metadata. Use Firestore batches/BulkWriter and make reruns safe; never import credentials or session tokens.
7. **Dry-run and compare before cutover.** Import into a staging Firebase project. Compare counts per collection, league ownership, club/player relationships, standings recalculated from fixtures, match events, visibility, and image access. Test public reads, private leagues, manager-only edits, Google sign-in, password recovery, and account linking.
8. **Deploy the migrated app to Vercel.** Connect the Git repository, select the framework/runtime used by the new handlers, configure Firebase Admin credentials and public Firebase web configuration as Vercel environment variables for Preview and Production, then deploy a Preview build. Add the deployed domain to Firebase Authentication's Authorized domains and Google OAuth's allowed origins/redirect settings.
9. **Cut over with a rollback point.** Put the old app in read-only mode, take a final SQLite backup/export, run the final import, verify the production domain, and then direct traffic to Vercel. Keep the old SQLite backup and deployment until production smoke tests and user sign-ins succeed. Do not run both systems as writable sources of truth.

Use Firebase Emulator Suite for development and staging rules tests. Keep service-account credentials in Vercel's encrypted environment variables or a secret manager, never in the repository. The migration is a backend rewrite, not a `vercel.json` setting; complete and test the Firestore-backed API before production cutover.

## Product extension points

League pages include a community-partner placement managed by the league creator, with a partner name, message, and website. Public visitors can send a sponsorship enquiry; only the creator can view the contact details and mark the enquiry as contacted. Enquiries are saved in SQLite; outbound email notifications are not configured. A future commercial release can add opt-in sponsor reporting and verified reach. League managers record their own scores; public league pages refresh those updates every 20 seconds. Automated professional fixtures and scores require a licensed sports-data provider.

## Companion products

The Products menu links to FairDraft (balanced team draws), Fixture Planner (standalone round-robin schedules), and Draw Verifier (independent draw verification). These remain separate browser-side tools; the verifier is independent of the league account system.
