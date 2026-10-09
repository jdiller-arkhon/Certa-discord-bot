# Arkhon Industries Discord bots

pnpm monorepo of TypeScript Discord bots (discord.js v14, Node 22, ESM).

```
packages/shared/   @arkhon/shared: helpers used by more than one bot
bots/certa/        Certa bot: flight logging, currency, preflight, leaderboard
```

## Commands

```bash
pnpm install             # install everything
pnpm test                # vitest, all packages
pnpm typecheck           # tsc -b over sources and tests
pnpm build               # compile to dist/
pnpm certa:dev           # run Certa bot with tsx watch, reading ../../.env
pnpm certa:register      # register Certa slash commands without starting the bot
docker compose up -d --build certa
```

Run `pnpm typecheck && pnpm test` before committing.

## Conventions

- **ESM + NodeNext.** Relative imports use the `.js` extension (`import { x } from './x.js'`).
- **Config** is loaded once with `loadEnv(schema)` from `@arkhon/shared`, which validates
  `process.env` with zod and lists every bad variable at startup. Blank values count as unset.
  Every new variable goes into `.env.example` with a comment.
- **Per-bot layout:** `src/index.ts` (bootstrap), `src/app.ts` (wiring into a context
  object), `src/config.ts`, `src/db.ts` (migrations), `src/store.ts` (SQL access),
  `src/commands/*` (one factory per command taking the context), `src/jobs.ts`
  (scheduled jobs), and pure logic in `src/domain/*` so it can be unit tested without Discord.
- **Commands** implement `SlashCommand`; buttons and modals implement `ComponentHandler`, routed
  by `customId` prefix (`prefix:arg1:arg2`, max 100 chars, built with `customId()`).
  `createInteractionRouter` catches errors: throw `UserFacingError` for a friendly ephemeral
  message; anything else is logged and the user sees a generic failure.
- **Replies** that are personal (account data, errors) are ephemeral (`MessageFlags.Ephemeral`).
  Defer before any network call that can exceed Discord's 3 second window.
- **Storage** is SQLite via better-sqlite3 (`openDatabase(path, migrations)`). Migrations are
  append-only and numbered from 1 (stored in `PRAGMA user_version`). Never edit a shipped migration.
- **Scheduled jobs** use `startScheduler` with `sqliteJobRunStore`, so each daily/monthly
  occurrence runs once even across restarts, catches up if the bot was down at the scheduled
  time, and retries failures after 10 minutes.
- **Outbound HTTP** goes through `request`/`requestJson` (per-attempt timeout, exponential
  backoff on 5xx/timeouts, no retry on 4xx). Wrap upstream data in zod schemas.
- **Logging** is JSON lines via `createLogger(botName)`. Log IDs, never tokens or message content.
- **Shared code:** add to `packages/shared` only when two bots need it.
- **Tests** live in `<package>/test/*.test.ts`. Vitest resolves `@arkhon/shared` to its sources.
  Upstream API tests use recorded responses in `test/fixtures/`.

## Certa bot (`bots/certa`)

Certa is Arkhon's drone flight operations and compliance logbook. The bot links Discord users
to Certa accounts and provides preflight information.

### Commands

| Command | What it does |
| --- | --- |
| `/certa link code:<code>` | Redeems a one-time code from Certa (Settings → Discord) and stores the mapping |
| `/certa unlink` | Removes the mapping, reminder history, and unshared flight summaries |
| `/certa reminders state:on\|off` | Opt in/out of recurrent training DMs |
| `/log mission:<type>` | Opens a modal (date, location, aircraft, minutes, notes) and logs the flight. Mission type is a command option because modals hold at most five inputs. Optional "Share to #flight-logs" button |
| `/hours` | Total flights/time plus 30/90/365 day breakdowns |
| `/currency` | Part 107 recurrent due date and days remaining |
| `/preflight icao:<code>` | METAR, TAF, Kp, nearby TFRs, and a go/caution summary |
| `/leaderboard [period]` | Top 10 by flight time this month (or all time) |

Account commands reply ephemerally with `NOT_LINKED_MESSAGE` when the user is not linked.

### Certa API

Commands depend only on the `CertaClient` interface (`src/certa/client.ts`).

- `HttpCertaClient`: `CERTA_API_BASE_URL` + bearer `CERTA_API_TOKEN`, 10s timeout per attempt,
  3 attempts with backoff (500ms, 1s) on 5xx/timeouts, and an `Idempotency-Key` on POSTs.
  Errors are mapped to `CertaInvalidLinkCodeError`, `CertaUserNotFoundError`,
  `CertaRejectedError`, `CertaAuthError`, `CertaUnavailableError`, and `CertaResponseError`;
  `callCerta()` in `src/context.ts` turns them into user-facing messages.
- `MockCertaClient` (`CERTA_CLIENT=mock`) stores data in the bot's own SQLite `mock_*` tables.
  Any well-formed code (6-32 chars of `A-Z 0-9 -`) links once. New mock pilots get recurrent
  training dated 23 months ago, which puts them inside the 60-day reminder window.
- All request/response types are zod schemas in `src/certa/types.ts`. Unknown response keys
  are stripped.

### Data rules

- **Never store FAA certificate numbers or other government ID numbers.** The bot DB holds
  Discord ID, Certa user ID, display name, reminder preference, reminder history, and a minimal
  public summary of each logged flight so it can be shared (no notes).
- Public flight posts use `publicLocation()`: ICAO codes kept, coordinates stripped, addresses
  reduced to "City, ST".

### Currency and reminders

- `recurrentDueDate()`: training in any day of month M is current through the last day of month
  M+24 (14 CFR 107.65 "24 calendar months"). Days remaining are counted in `CERTA_TIMEZONE`.
- Daily job `recurrent-reminders` at `CERTA_REMINDER_TIME`: `selectReminder()` sends only the
  most urgent threshold reached (60/30/14/3 days) that hasn't been sent for the current due date,
  and records skipped larger thresholds too. History is keyed by due date, so completing training
  starts a fresh cycle. A reminder is recorded only after the DM succeeds.

### Preflight

- METAR/TAF: `https://aviationweather.gov/api/data/{metar,taf}?ids=ICAO&format=json`
  (an unknown station returns HTTP 204 with an empty body).
- Kp: `https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json` (array of objects;
  the legacy array-of-arrays format is also parsed). Elevated at `PREFLIGHT_KP_CAUTION` (5).
- TFRs: FAA GeoServer WFS behind tfr.faa.gov (`/geoserver/TFR/ows`, layer `TFR:V_TFR_LOC`,
  GeoJSON), verified October 2026. Filtered to `PREFLIGHT_TFR_RADIUS_NM` from the METAR station
  position. On any failure the embed shows "TFR data unavailable, check tfr.faa.gov".
- Each source is cached for 10 minutes (`TtlCache`) and fails independently.
- `assessConditions()` gives GO/CAUTION from wind, gusts, visibility, ceiling, and Kp using the
  `PREFLIGHT_*` thresholds. Missing or stale (>90 min) data is a CAUTION.
- The embed footer always carries the advisory and LAANC/DroneZone notice (`ADVISORY_FOOTER`).
- Daily job `daily-preflight` posts all `CERTA_PREFLIGHT_AIRPORTS` to `CERTA_PREFLIGHT_CHANNEL_ID`
  at `CERTA_PREFLIGHT_TIME`.

### Leaderboard

- Monthly job `monthly-leaderboard` posts the previous month's final top 10 to
  `CERTA_PILOT_LOUNGE_CHANNEL_ID` on the 1st at `CERTA_LEADERBOARD_TIME`, using
  `getLeaderboard('month', { month: 'YYYY-MM' })`.

### Jobs that are disabled

A job whose channel ID (and, for preflight, airport list) is unset is not scheduled; the bot logs
that at startup.
