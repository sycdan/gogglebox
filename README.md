# Gogglebox

_Watch together, decide together._

Gogglebox is a LAN-first [Jellyfin](https://jellyfin.org/) frontend for people who want the best possible
experience choosing and watching something as a party. It treats the room as the
important unit: pick who is watching, see what makes sense for that set of people,
and hand off playback to Jellyfin without turning movie night into admin work.

Jellyfin remains the source of truth for media, metadata, and watch history.
Gogglebox sits in front of it as a focused, party-aware layer for shared
selection, shared progress, and a smoother path from "what should we watch?" to
"press play."

## What it does today

Users are referenced by their (unique) Jellyfin name in `config.json`; Gogglebox
resolves names to ids itself at startup. One or more login accounts each see only
the users they are allowed to, and parties are formed live in the UI (a party is a
Jellyfin user created on demand). Parties were formerly called "groups" — the
server still accepts the old `/api/group*` routes and response fields as
compatibility aliases (see `src/server/server.ts`). Jellyfin remains the source
of truth for library, metadata, and watch history; Gogglebox is a thin
party-aware layer on top.

When enabled by feature flag, the main discovery surface deals a finite
Tonight's Nine set for the active party and shows it as three large cards: the
selected card in the middle with readable neighbors on either side. The room can
move focus, register lightweight positive sentiment, dismiss a pick for tonight,
start a short play countdown, or hold play to launch the focused item
immediately.

## Where it is going

The work backlog lives under [`efforts`](./efforts). Current top-level efforts include
authentication, persistence, show-detail browsing, and the `v2026.8.29`
"Judgement Day" discovery work.

Judgement Day is the main product direction: fact-driven, explainable
recommendations for the whole room, presented as "Tonight's Nine": a finite set
of nine session picks shown through three large, couch-readable cards with a
slight center focus. Recommendation channels contribute weighted evidence to the
same item ids, so party resume, party next-up, newly added, party-seen, and
library quality can all reinforce the same movie, episode, or show without
needing separate ranking machinery. Controller-first input remains the target:
quick play starts a short countdown, hold play starts the focused item
immediately, and explicit up/down sentiment teaches the system without exposing
individual watch-progress history. Planned work is described in the effort
specs.

## Deployment

Gogglebox is meant to be simple to run on a LAN. A deployment host needs Docker
Compose, access to your Jellyfin server, and a small amount of local config.
The published image is served behind Caddy so the browser reaches one origin:

- `/` for the Gogglebox client
- `/api/*` for the Gogglebox server
- `/player/*` for Jellyfin Web

That single origin is what lets Gogglebox prepare the Jellyfin player handoff.

### Basic deploy flow

Copy the [`deploy/`](deploy/) folder to the machine that will host Gogglebox,
then in that folder:

```bash
cp .env.example .env
cp config.example.json config.json
```

In `config.json`, configure schemaVersion 2 auth: list the Jellyfin users
Gogglebox may show, define one or more household accounts, and map login tokens
to those accounts. Use Jellyfin user names, not UUIDs. Older supported config
shapes are migrated automatically by the app on startup.

In `.env`, set the required deployment values:

| Var                 | Purpose                                   |
| ------------------- | ----------------------------------------- |
| `GOGGLEBOX_VERSION` | Release to run (image and stack together) |
| `GOGGLEBOX_PORT`    | Host port for the Gogglebox front door    |
| `JELLYFIN_URL`      | Normal Jellyfin origin, without `/player` |
| `JELLYFIN_API_KEY`  | Jellyfin API key                          |
| `SESSION_SECRET`    | Long random string for session cookies    |

`ACCESS_TOKEN` is optional. When set to a token that exists in `config.json`,
Gogglebox automatically logs the browser into that token's account and skips the
token form. Leave it unset when you want visitors to type their token.

Start Gogglebox:

```bash
docker compose up -d -y
```

Open `http://<host>:<GOGGLEBOX_PORT>`.

The folder holds only your settings. The stack itself (the app, a private GO
Feature Flag sidecar, and the same-origin proxy) is published for each release
and pulled for the `GOGGLEBOX_VERSION` in `.env`, so upgrading or rolling back
is changing that value and running `docker compose up -d -y` again. `-y` accepts
Compose's prompt to confirm the variables a remote stack uses. Tested with Docker
Compose v5.

Useful commands, run in the folder:

```bash
docker compose ps
docker compose logs -f
docker compose down
```

Runtime state, such as ignored items, lives in the stack's `state` volume and
survives upgrades.

Flag defaults ship with the stack (`tonights-nine` is disabled). To override
them, put a complete GOFF flag file in the folder and add to
`docker-compose.yml`:

```yaml
services:
  goff:
    configs: !override
      - source: goff-relay
        target: /goff/goff-proxy.yaml
      - source: my-flags
        target: /goff/flags.goff.yaml
configs:
  my-flags:
    file: ./flags.goff.yaml
```

### Auth config

Gogglebox login is token-only. A visitor enters one access token; that token maps
to an account key in `access_tokens`, and the account controls which Jellyfin
users the visitor can select. There is no separate username/password portal
login in the current config model.

```json
{
  "schemaVersion": 2,
  "users": [
    { "jellyfin_name": "Alice", "pin": "1234" },
    { "jellyfin_name": "Bob" },
    { "jellyfin_name": "Carol", "pin": "5678" }
  ],
  "accounts": {
    "living_room": {
      "primary_users": ["Alice"],
      "secondary_users": ["Bob"],
      "tertiary_users": ["Carol"]
    }
  },
  "access_tokens": {
    "replace-with-a-long-random-token": "living_room"
  }
}
```

After a successful manual token login, the browser remembers the token in local
storage and uses it on later visits until Log out is clicked. This is separate
from `ACCESS_TOKEN` auto-login, which is configured on the server and applies to
any browser reaching that deployment.

Account tiers control the picker:

- `primary_users` are selected by default when the account opens Gogglebox.
- `secondary_users` are shown as normal selectable viewers, but are not selected
  by default.
- `tertiary_users` are guests. They are hidden behind Add guest and require the
  configured user PIN whenever they are added to a party for that account.

If `secondary_users` or `tertiary_users` is omitted or set to `null`, it acts as
a wildcard over the remaining live Jellyfin users after higher-priority tiers
are assigned. Guests without a configured `pin` in `users` are not addable,
because Gogglebox cannot verify them.

### Config manager deployment

Set `GOGGLEBOX_CONFIG_MANAGER_URL` to the manager's internal Compose URL (for
example, `http://config-manager:3001`). At startup Gogglebox reads the active
`config.json` from that API and validates it against live Jellyfin users. It
does not need a Git or Docker mount. An authenticated page shows a pending
config commit as an alert on the top-right account menu. Open
**Administration** from that menu to review the active and available revisions
and choose **Restart and update**. Gogglebox validates the candidate config and
sends the exact SHA to the manager, which owns the Git checkout and redeploys
the ordinary Compose services. The manager is not exposed through Caddy. The
private `whh-gogglebox-config` README describes the HTPC setup, rollout, and
recovery.

Other deployments can continue using their local `config.json`. The older
`GOGGLEBOX_CONFIG_REPO` and **Sync config** path remains available for existing
deployments during migration, but the HTPC Compose file no longer uses it.

## Development

Development also runs through Docker Compose. The host should not need Node,
npm, or a host `node_modules`; dependencies live in Docker volumes.

Every local stack is the published stack in `docker-compose.base.yml`, layered:

| Wrapper             | Layers                                  | Use                                           |
| ------------------- | --------------------------------------- | --------------------------------------------- |
| `./scripts/e2e.sh`  | base + `docker-compose.e2e.yml`         | The production image against a seeded sandbox Jellyfin; what CI runs |
| `./scripts/dev.sh`  | the above + `docker-compose.dev.yml`    | The same stack with hot-reloading server and client |

Both take any `docker compose` arguments and serve the app at
`http://localhost:8080` (`GOGGLEBOX_PORT` changes it) through the same proxy
self-hosters run. Bootstrap the sandbox once:

```bash
./scripts/e2e.sh up -d jellyfin-sandbox
./scripts/e2e.sh run --rm sandbox-generate
./scripts/e2e.sh run --rm sandbox-provision
```

Then iterate with hot reload, and prove against the production image before
pushing:

```bash
./scripts/dev.sh up -d
./scripts/dev.sh run --rm -e PROOF_FLOW=mark-all-watched proof

./scripts/e2e.sh run --rm sandbox-reset
./scripts/e2e.sh up -d --build --wait
./scripts/e2e.sh run --rm -e PROOF_FLOW=all proof
```

Checks that need no Jellyfin: `./scripts/e2e.sh run --rm check` and
`./scripts/e2e.sh run --rm test`. `./scripts/e2e.sh down -v` discards the sandbox.

When a proof needs a different flag state, override the flags the same way as
a deployment (see "Basic deploy flow") in an extra `-f` file; complete GOFF
fixtures live under `tools/goff/fixtures/`.

See the [agent guide](kb/00000000-0000-0000-0000-000000000000.md)
for the agent workflow and the Docker-specific rules that keep local
development consistent.

## Releases

Images are published to `ghcr.io/sycdan/gogglebox`. Maintainers use the repo's
versioning and publish scripts/workflows to build once, test once, and promote a
tested image to a release tag. Deployers can pin `GOGGLEBOX_VERSION` in
`deploy/.env` when they want reproducible upgrades and rollbacks.

## Legal Use

Gogglebox is a self-hosted companion interface for Jellyfin. It does not
provide, host, index, download, rip, decrypt, or distribute media.

You are responsible for ensuring that your Jellyfin server, media library, user
access, network exposure, and any sharing you configure comply with applicable
law and with the rights associated with your media. Do not use Gogglebox to make
copyrighted works available to others unless you have the right to do so.

Gogglebox is intended for lawful personal and household use with media you are
authorized to access.

---

In loving memory of [Oggie](./mascot.jpg).
