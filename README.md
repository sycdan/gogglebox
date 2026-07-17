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

## Where it is going

The work backlog lives under [`efforts`](./efforts). Current top-level efforts include
authentication, persistence, show-detail browsing, and the `v2026.8.29`
"Judgement Day" discovery work.

Judgement Day is the main product direction: fact-driven, explainable
recommendations for the whole room, presented as a finite "tonight's deck"
(one hero proposal plus an on-deck strip) with controller-first input — log
in, press Start, and the top pick plays. Planned work is described in the
effort specs.

## Deployment

Gogglebox is meant to be simple to run on a LAN. A deployment host needs Docker
Compose, git, access to your Jellyfin server, and a small amount of local config.
The published image is served behind Caddy so the browser reaches one origin:

- `/` for the Gogglebox client
- `/api/*` for the Gogglebox server
- `/player/*` for Jellyfin Web

That single origin is what lets Gogglebox prepare the Jellyfin player handoff.

### Basic deploy flow

Clone the repo on the machine that will host Gogglebox:

```bash
git clone <repo-url>
cd gogglebox
```

Copy and edit the deploy config:

```bash
cp deploy/config.example.json deploy/config.json
cp deploy/.env.example deploy/.env
```

In `deploy/config.json`, configure schemaVersion 2 auth: list the Jellyfin users
Gogglebox may show, define one or more household accounts, and map login tokens
to those accounts. Use Jellyfin user names, not UUIDs. Older supported config
shapes are migrated automatically by the app on startup.

In `deploy/.env`, set the required deployment values:

| Var                | Purpose                                   |
| ------------------ | ----------------------------------------- |
| `GOGGLEBOX_PORT`   | Host port for the Gogglebox front door    |
| `JELLYFIN_URL`     | Normal Jellyfin origin, without `/player` |
| `JELLYFIN_API_KEY` | Jellyfin API key                          |
| `SESSION_SECRET`   | Long random string for session cookies    |

`ACCESS_TOKEN` is optional. When set to a token that exists in
`deploy/config.json`, Gogglebox automatically logs the browser into that token's
account and skips the token form. Leave it unset when you want visitors to type
their token.

Start Gogglebox from the repo root:

```bash
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d
```

Open `http://<host>:<GOGGLEBOX_PORT>`.

Useful deploy commands:

```bash
docker compose -f deploy/docker-compose.yml --env-file deploy/.env ps
docker compose -f deploy/docker-compose.yml --env-file deploy/.env logs -f
docker compose -f deploy/docker-compose.yml --env-file deploy/.env down
```

Runtime state, such as ignored items, is stored under the configured state
directory. For a real deployment, set `GOGGLEBOX_STATE_DIR` to a durable host
path that is writable by container uid `1000`.

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

## Development

Development also runs through Docker Compose. The host should not need Node,
npm, or a host `node_modules`; dependencies live in Docker volumes.

The base compose file is for checks that do not need Jellyfin:

```bash
docker compose run --rm check
docker compose run --rm test
docker compose down
```

To run the full app, use one of the wrapper stacks:

| Stack              | Purpose                                                   |
| ------------------ | --------------------------------------------------------- |
| `./scripts/sbx.sh` | Seeded offline sandbox Jellyfin for repeatable local work |
| `./scripts/uat.sh` | A developer's real Jellyfin for user-acceptance testing   |

Both stacks serve the app through `http://localhost:8080` with `/api` routed to
Gogglebox and `/player` routed to Jellyfin. The server and client services do
not expose separate host ports.

Common examples:

```bash
./scripts/sbx.sh up -d
PROOF_FLOW=mark-all-watched ./scripts/sbx.sh run --rm proof

./scripts/uat.sh up -d
PROOF_FLOW=continue-watching ./scripts/uat.sh run --rm proof
```

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
