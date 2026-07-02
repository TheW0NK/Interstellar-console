# Vexium Panel

A self-hosted control panel for the Vexium Paper server. This panel **owns
the java process directly** — it starts and stops the server itself by
running the `java` command, rather than attaching to something already
running under MintServers/Pterodactyl/screen/systemd. Console commands are
sent over RCON, not stdin.

## How it works

- **Power controls** (Start/Restart/Stop/Kill) spawn or signal the `java`
  child process directly (`src/processManager.js`).
- **Console** streams the child process's stdout/stderr live over a
  WebSocket. Commands typed in the console (or sent from Quick Tasks) go out
  over **RCON**, not stdin — so RCON must be enabled.
- **Auth** is a flat YAML file (`config/users.yml`) with bcrypt-hashed
  passwords, since this is meant for local/physical access only. No OAuth,
  no external identity provider.
- **Stats** (CPU/mem) are read straight from `/proc/<pid>` on Linux. Disk
  usage comes from the filesystem the server directory lives on. TPS/MSPT
  are polled from RCON's `/tps` and `/mspt` commands every few seconds
  while a client is connected, and shown both in the topbar and on the
  Dashboard's TPS card (color-coded: green ≥18, yellow ≥15, red below).
- **Recent activity** on the Dashboard is backed by `data/activity.yml` —
  a flat, human-readable YAML log of who did what (logins, power actions,
  backups, plugin installs/removals, player kicks/bans/ops, config saves,
  schedule runs). Capped at the 200 most recent entries. New entries also
  push live to any open dashboard over the websocket.
- **Branding** — the sidebar, login screen, and browser tab show a
  configurable "Server name" (`config/branding.yml`, editable from the
  MC Configuration tab under "Panel Branding"). The logo is pulled
  automatically from `server-icon.png` in your server directory — the same
  64×64 icon Minecraft shows in the multiplayer list — with no separate
  upload step; just drop the file in (or use the File Manager) and refresh.
  If no icon is present, the panel falls back to a letter mark using the
  server name's first character. The name/icon are served from public,
  unauthenticated endpoints (`GET /api/branding`, `GET /api/server-icon`)
  so they show up on the login screen before anyone signs in; only
  changing the name requires a session.
- **Backups** are `tar.gz` archives built with the system `tar` binary.
- **Plugin Installer** searches and installs from the Hangar (PaperMC) API.
- **Player Manager** combines RCON `list` output with `ops.json`,
  `whitelist.json`, `banned-players.json`, and `usercache.json` from the
  server directory. Playtime/ping aren't available without a stats plugin,
  so those fields are intentionally left blank rather than faked.

## Requirements

- Node.js 18+ (uses the built-in `fetch`)
- Linux (stats sampling reads `/proc`; backups shell out to `tar`)
- Java already installed and able to run your `paper.jar`
- `tar` on PATH (already true on basically every Linux box)

## Setup

1. **Install dependencies**

   ```bash
   npm install
   ```

2. **Edit `config/config.yml`**

   At minimum, set:
   - `server.directory` — absolute path to the folder with `paper.jar`
   - `server.javaArgs` / `extraArgs` — your usual JVM flags
   - `rcon.password` — must match what you put in `server.properties`
   - `panel.sessionSecret` — change from the placeholder to something random
   - `sftp.*` — informational only, fill in to match your actual SSH/SFTP setup

3. **Enable RCON in your server's `server.properties`**

   ```properties
   enable-rcon=true
   rcon.port=25575
   rcon.password=<same password as config.yml>
   ```

   RCON only works once the server is already running, so the panel starts
   the server by spawning `java` directly and connects RCON afterward, once
   it sees a `Done (` line in the console output.

4. **Create your first administrator**

   ```bash
   node scripts/add-user.js adrian owner
   ```

   This prompts for a password (hidden input), hashes it, and appends the
   account to `config/users.yml`. Valid roles: `owner`, `admin`,
   `moderator`. Only `owner`/`admin` can access Administrator Management in
   the panel itself.

5. **Start the panel**

   ```bash
   npm start
   ```

   By default it binds to `127.0.0.1:8080` (see `panel.bind` / `panel.port`
   in the config). Open that URL in a browser and sign in.

## Notes / limitations

- **The panel must be running for the server to be running** — since it
  owns the process, closing the panel process (or the machine rebooting
  without something re-launching it) means the Minecraft server goes down
  too. If you want the panel itself to survive reboots, run it under
  systemd or `pm2`.
- **Sessions are in-memory** — restarting the panel process logs everyone
  out. Fine for a small local panel; swap in a persistent session store if
  that's annoying.
- **RCON response reassembly is single-packet** — fine for normal commands;
  very large responses (e.g. `/plugins` with 100+ plugins) could
  theoretically span multiple RCON packets, which this client doesn't
  stitch back together.
- **File manager, backups, and plugin installs are strictly scoped** to
  `server.directory` / `backups.directory` / `plugins/` — path traversal is
  blocked, but there's no per-admin-role restriction on file access yet
  (any signed-in admin can edit any file the panel can see).
- Adding an administrator through the UI works, but if you'd rather edit
  `config/users.yml` by hand, use `node scripts/add-user.js` to get a
  properly bcrypt-hashed entry — never hand-write plaintext passwords into
  that file.

## Project layout

```
config/
  config.yml        # your settings — server path, java args, rcon, sftp info
  users.yml         # bcrypt-hashed admin accounts (edit via add-user.js)
  branding.yml      # panel display name (editable in the UI too)
data/
  backups/          # tar.gz backups land here
  schedules.json    # created automatically on first schedule
  activity.yml      # recent-activity feed, created automatically
src/
  server.js         # express app + websocket hub, entry point
  processManager.js # owns the java child process
  rcon.js           # Source RCON protocol client
  auth.js           # yaml-backed user store + session middleware
  stats.js          # /proc-based CPU/mem sampling
  routes/           # one file per API area
public/
  index.html        # the panel UI (single file, no build step)
scripts/
  add-user.js        # CLI to add an admin account
```
