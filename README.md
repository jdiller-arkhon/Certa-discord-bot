# Arkhon Industries Discord bots

Discord bots for Arkhon Industries. This repository currently contains:

- **Certa bot** (`bots/certa`): link your Certa logbook account, log flights, check hours and
  Part 107 recurrent training currency, get preflight conditions, and see the flight time leaderboard.

See [`CLAUDE.md`](CLAUDE.md) for architecture and conventions.

## Requirements

- Node.js 22+ and pnpm 10 (`corepack enable`)
- A Discord application with a bot user
- Docker (optional, for deployment)

## Certa bot

### 1. Create the Discord application

1. Go to <https://discord.com/developers/applications> and create an application.
2. Under **Bot**, reset and copy the token (`DISCORD_TOKEN`). No privileged intents are needed.
3. Copy the **Application ID** from **General Information** (`DISCORD_APPLICATION_ID`).
4. Under **OAuth2 → URL Generator** choose the scopes `bot` and `applications.commands` and the
   permissions **Send Messages**, **Embed Links**, and **View Channels**, then open the URL to invite
   the bot to your server.
5. Enable Developer Mode in Discord (User Settings → Advanced) so you can copy channel and server IDs.

### 2. Configure

```bash
cp .env.example .env
```

Fill in at least `DISCORD_TOKEN` and `DISCORD_APPLICATION_ID`. For development also set
`DISCORD_GUILD_ID` so commands appear in your server immediately (global registration can take up to an
hour).

| Variable | Purpose |
| --- | --- |
| `CERTA_CLIENT` | `mock` runs entirely off the local database; `http` uses the Certa API |
| `CERTA_API_BASE_URL`, `CERTA_API_TOKEN` | Required for `http` |
| `CERTA_TIMEZONE` | Time zone for dates and scheduled jobs (default `America/Denver`) |
| `CERTA_FLIGHT_LOGS_CHANNEL_ID` | Enables the "Share to #flight-logs" button |
| `CERTA_PREFLIGHT_CHANNEL_ID`, `CERTA_PREFLIGHT_AIRPORTS`, `CERTA_PREFLIGHT_TIME` | Daily preflight post |
| `CERTA_PILOT_LOUNGE_CHANNEL_ID`, `CERTA_LEADERBOARD_TIME` | Monthly leaderboard post on the 1st |
| `CERTA_REMINDER_TIME` | When recurrent training reminder DMs go out |
| `PREFLIGHT_*` | Go/caution thresholds and TFR search radius |

### 3. Run locally

```bash
pnpm install
pnpm certa:dev
```

Slash commands are registered every time the bot starts. To register them without starting the bot,
run `pnpm certa:register`.

**Trying it with the mock backend:** with `CERTA_CLIENT=mock`, run `/certa link code:TEST01` (any
6-32 character code of letters, digits, and dashes works once), then `/log`, `/hours`, `/currency`,
and `/leaderboard`. Mock pilots start with recurrent training due in roughly 50-60 days so the
reminder DMs can be seen on the next daily run.

### 4. Deploy with Docker

```bash
docker compose up -d --build certa
docker compose logs -f certa
```

The SQLite database lives in the `certa-data` volume at `/app/data/certa.sqlite`.

### Using the bot

| Command | Description |
| --- | --- |
| `/certa link code:<code>` | Link your account with a one-time code from Certa → Settings → Discord |
| `/certa unlink` | Unlink your account |
| `/certa reminders state:on\|off` | Turn recurrent training reminder DMs on or off |
| `/log mission:<type>` | Log a flight (opens a form) |
| `/hours` | Your flight totals |
| `/currency` | Your Part 107 recurrent training due date |
| `/preflight icao:<code>` | Weather, Kp index, and nearby TFRs for an airport |
| `/leaderboard` | Top 10 pilots by flight time this month |

Preflight output is advisory only. Always check official sources and obtain airspace authorization
(LAANC or FAADroneZone) where required.

## Development

```bash
pnpm test        # unit tests
pnpm typecheck   # TypeScript, including tests
pnpm build       # compile all packages
```
