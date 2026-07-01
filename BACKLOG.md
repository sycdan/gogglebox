# Gogglebox Backlog

## 🐞 To fix

### e2e `player-handoff` proof blocked — seed client ignores Jellyfin `/player` base path

**Symptom.** `PROOF_FLOW=player-handoff` fails with
`found no Resume/Play affordance to trigger the player session mint`. Upstream
logs: `[seed] household: config names matched no live users (4 names); falling
back to ALL users` then `seed skipped ([seed] no household viewers resolved)`.
No in-progress episode gets seeded → no Continue-watching Resume/Play button →
the flow aborts before the gbx launch panel / Jellyfin handoff tab are ever
reached. (group-pin, group-alias, and the default app flow all PASS — they don't
seed; they read the running server.)

**Root cause.** The sandbox Jellyfin (real `jellyfin/jellyfin:10.9.11`) runs with
network `BaseUrl=/player`, so its REST API lives under `…:8096/player/...`. Two
clients reach it differently:

- The **server** auto-discovers the base (tries bare, then `/player` — see
  `resolveActiveBase` in provisioning / `src/server/jellyfin.ts`), so a bare URL
  works. This is why the picker shows all 4 users.
- The **e2e seed client** (`e2e/lib/jellyfin.mjs`) does **no** discovery — it just
  appends paths to `JELLYFIN_URL`. With a bare URL, `GET /Users` hits the
  Jellyfin web SPA (HTML), parses to `[]`, and `seedInProgressEpisode` throws
  `no household viewers resolved`.

The `proof` service receives `JELLYFIN_URL` via
`environment: JELLYFIN_URL=${JELLYFIN_URL}` (`docker-compose.yml:137`), which is
**parse-time interpolation from the default `.env` (bare)** and therefore
*overrides* the `/player` value `.env.sbx` supplies through `env_file`. Proof:
`./scripts/sbx.sh run --rm --entrypoint sh proof -c 'echo $JELLYFIN_URL'` prints
`http://jellyfin-sandbox:8096` (bare); appending `/player` to the same call makes
`/Users` return the real Alice/Bob/Carol/Dave JSON. `.env.sbx` itself correctly
holds `JELLYFIN_URL=http://jellyfin-sandbox:8096/player`.

**Pre-existing on main — NOT introduced by the user/auth refactor.** `git diff
main...HEAD` is empty for `docker-compose.yml`, `docker-compose.sbx.yml`, and the
`/player` emission in `tools/sandbox/provision.mjs`. The only changed seed file,
`e2e/lib/household.mjs`, is a faithful GUID→name port whose empty-result fallback
is identical in shape to main; it is not the cause. The same bare-URL seed client
would fail on main.

**Fix options.**

- **(preferred)** Give `e2e/lib/jellyfin.mjs` the same bare→`/player` base
  discovery the server uses, so the seed client is env-agnostic and matches
  server behaviour.
- Or make the `proof` service honour `.env.sbx` for `JELLYFIN_URL` instead of the
  parse-time `${JELLYFIN_URL}` override (note `.env` is shared with the `uat`
  stack, whose real Jellyfin may not use `/player` — don't just bake `/player`
  into `.env`).

**Verify.**
`./scripts/sbx.sh run --rm -e PROOF_URL=http://proxy:8080 -e PROOF_FLOW=player-handoff proof`
should seed an in-progress episode, click Resume, and produce
`player-handoff-gbx.png` + `player-handoff-jellyfin-loggedin.png` (Jellyfin tab
logged in, NO manual login form).
