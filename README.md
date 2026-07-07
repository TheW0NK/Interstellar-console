# Vexium Panel

A self-hosted control panel for a Paper Minecraft server or a Velocity
proxy (`server.type: paper` or `velocity` in `config/config.yml`). This
panel **owns the java process directly** — it starts and stops the server
itself by running the `java` command, rather than attaching to something
already running under MintServers/Pterodactyl/screen/systemd. Console
commands are written straight to that process's **stdin** — there's no
RCON dependency at all, so there's nothing extra to enable in
`server.properties`.

## How it works

- **Power controls** (Start/Restart/Stop/Kill) spawn or signal the `java`
  child process directly (`src/processManager.js`).
- **Console** streams the child process's stdout/stderr live over a
  WebSocket. Commands typed in the console (or sent from Quick Tasks,
  Player Manager, Schedules, etc.) are written directly to the process's
  **stdin** — the same as typing them into the server's own terminal.
  Because stdin has no built-in request/response framing (unlike RCON),
  the panel captures whatever the console prints in the ~250ms after a
  command is sent (up to a 1.5s hard cap) and treats that as the "response."
  This is a best-effort heuristic, not a guarantee — see Limitations below.
  Color is rendered too: both real ANSI escape codes (what Paper/Velocity
  write via their TerminalConsoleAppender) and raw Minecraft §-formatting
  codes are parsed into actual colored/bold/underlined text client-side —
  nothing is stripped before display, and log-level detection tolerates
  ANSI codes wrapping the `[HH:mm:ss LEVEL]:` prefix.
- **Auth** is a flat YAML file (`config/users.yml`) with bcrypt-hashed
  passwords, since this is meant for local/physical access only. No OAuth,
  no external identity provider. Administrator Management lets you set a
  real password (not just an auto-generated placeholder) when creating an
  account, and owners/admins can reset any other admin's password at any
  time from the same tab — an 8-character minimum is enforced both in the
  UI and server-side.
- **MC Configuration / Proxy Configuration** exposes **every** key in
  `server.properties` (Paper) or the flat scalar keys in `velocity.toml`
  (Velocity) — searchable, nothing curated or hidden. Booleans render as
  toggles, numbers as number inputs, anything with "password" in the key
  as a password input. For Velocity, array/table values (like
  `servers.try`) aren't shown — those need the File Manager, since a
  generic key=value editor can't safely round-trip TOML's richer types.
- **Stats** (CPU/mem) are read straight from `/proc/<pid>` on Linux. Disk
  usage comes from the filesystem the server directory lives on. **TPS/MSPT
  are read from a file, not a console command** — see "Live TPS/MSPT"
  below. If that file isn't present, the TPS card just shows "Not
  installed" instead of a number; nothing else is affected.
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
- **Player Manager** combines a console `list` command with `ops.json`,
  `whitelist.json`, `banned-players.json`, and `usercache.json` from the
  server directory. Playtime/ping aren't available without a stats plugin,
  so those fields are intentionally left blank rather than faked. **On
  Velocity**, none of this applies — those files live on your backend
  Paper servers, not the proxy — so Player Manager instead shows the raw
  output of `glist all`, with no kick/ban/op/whitelist actions. I didn't
  reimplement those for Velocity because I'm not confident enough in its
  exact console command surface to guess at syntax that might silently do
  the wrong thing; better to show you the raw output than a broken button.

## Live TPS/MSPT

TPS and MSPT are **not** read by sending commands to the console — that
was the original approach and it was noisy and inefficient (a command
queued every few seconds, competing with real commands, spamming the
console log). Instead:

- An optional companion plugin, **Vexium Bridge** (source in `/plugin`),
  writes `plugins/VexiumBridge/stats.json` every 5 seconds using Paper's
  own `getTPS()`/`getAverageTickTime()` APIs — the same numbers `/tps` and
  `/mspt` would give you, just pushed to a file instead of typed as a
  command.
- The panel already samples CPU/mem/disk every 2 seconds for the resource
  graphs (`src/stats.js`); it now also reads that JSON file on the same
  tick — a plain `fs.readFileSync` of a ~150-byte file, not a subprocess
  call or a queued command. If the file is missing, unreadable, or hasn't
  been updated in the last 15 seconds (server likely stopped or the plugin
  isn't running), the TPS card shows "Not installed" or "Stale" instead of
  a stale number.
- **This plugin is entirely optional.** Without it, every other part of
  the panel works exactly the same — you just don't get the TPS card.

See `plugin/README.md` for build and install instructions (you'll need a
JDK and Maven on a machine with internet access, since it pulls the Paper
API from PaperMC's repo — that step doesn't run inside the panel).



- Node.js 18+ (uses the built-in `fetch`)
- Linux (stats sampling reads `/proc`; backups shell out to `tar`)
- Java already installed and able to run your `paper.jar`
- `tar` on PATH (already true on basically every Linux box)

## Velocity support

Set `server.type: "velocity"` in `config/config.yml` and point
`server.directory`/`jarFile` at your Velocity install instead of Paper's.
What changes automatically:

- **Stop/Restart** send `shutdown` to the console instead of `stop`.
- **MC Configuration** becomes "Proxy Configuration" and edits
  `velocity.toml` (flat scalar keys only — see above) instead of
  `server.properties`.
- **Plugin Installer** searches Hangar's `VELOCITY` platform instead of
  `PAPER`.
- **Player Manager** shows raw `glist all` output instead of a managed
  table (see above for why).
- **Quick Tasks** hides the Paper-only tiles (Save All, Reload Plugins,
  Toggle Whitelist, Op/Deop, Save-Off/Save-On) — Velocity has no worlds
  to save and no vanilla-style whitelist/op commands.
- **Backups**: update `backups.include` yourself — something like
  `["velocity.toml", "forwarding.secret", "plugins"]` instead of world
  folders.
- The **Vexium Bridge plugin** (TPS/MSPT) is Paper-only and has no effect
  on Velocity; the TPS card just won't be useful there.

One honest caveat: I'm confident about the process lifecycle (spawning
`java -jar velocity.jar` is identical to Paper) and reasonably confident
Velocity's startup log still contains "Done (...)!" like vanilla/Paper do,
since Velocity deliberately mirrors that phrasing for tooling
compatibility — but I haven't run this against a real Velocity instance,
only a stand-in that mimics the behavior I expect. If your Velocity build
logs something different at startup, the panel will just sit in
"STARTING" forever; check the Console tab and adjust if needed.



1. **Install dependencies**

   ```bash
   npm install
   ```

2. **Edit `config/config.yml`**

   At minimum, set:
   - `server.type` — `"paper"` (default) or `"velocity"` — see Velocity support above
   - `server.directory` — absolute path to the folder with `paper.jar` (or `velocity.jar`)
   - `server.javaArgs` / `extraArgs` — your usual JVM flags
   - `panel.sessionSecret` — change from the placeholder to something random
   - `sftp.*` — informational only, fill in to match your actual SSH/SFTP setup

   Nothing needs to change in `server.properties` — RCON is not used, so
   `enable-rcon` can stay off.

3. **Create your first administrator**

   ```bash
   node scripts/add-user.js adrian owner
   ```

   This prompts for a password (hidden input), hashes it, and appends the
   account to `config/users.yml`. Valid roles: `owner`, `admin`,
   `moderator`. Only `owner`/`admin` can access Administrator Management in
   the panel itself.

4. **Start the panel**

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
- **Command "responses" are a heuristic, not a guarantee.** Since stdin
  has no request/response protocol, the panel just watches the console for
  ~250ms of quiet (capped at 1.5s) after sending a command and calls that
  the response. In normal use this works fine — the server prints its
  reply to a command almost immediately, before anything else happens.
  But if a command is issued at the exact moment something else is logging
  heavily (a player joining, a plugin spamming its own output, chunk
  generation, etc.), the captured "response" can include unrelated lines,
  or the real response can arrive just after the capture window closes and
  get missed. Commands are serialized (one at a time, queued) so two
  concurrent commands can't steal each other's output, but this doesn't
  fully eliminate cross-talk with the server's own background logging.
  This affects things like Player Manager actions and anything typed into
  the Console tab — it does **not** affect TPS/MSPT, which reads from the
  Vexium Bridge plugin's file instead (see above) specifically to avoid
  this problem.
- **Sessions are in-memory** — restarting the panel process logs everyone
  out. Fine for a small local panel; swap in a persistent session store if
  that's annoying.
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
  config.yml        # your settings — server path, java args, sftp info
  users.yml         # bcrypt-hashed admin accounts (edit via add-user.js)
  branding.yml      # panel display name (editable in the UI too)
data/
  backups/          # tar.gz backups land here
  schedules.json    # created automatically on first schedule
  activity.yml      # recent-activity feed, created automatically
src/
  server.js         # express app + websocket hub, entry point
  processManager.js # owns the java child process, sends commands via stdin
  auth.js           # yaml-backed user store + session middleware
  stats.js          # /proc-based CPU/mem sampling
  routes/           # one file per API area
public/
  index.html        # the panel UI (single file, no build step)
scripts/
  add-user.js        # CLI to add an admin account
plugin/
  pom.xml            # Maven build for the optional Vexium Bridge plugin
  src/               # plugin source — see plugin/README.md to build/install
```
