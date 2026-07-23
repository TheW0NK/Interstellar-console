# Vexium Panel

A self-hosted control panel for a Paper Minecraft server or a Velocity proxy.
It owns the java process directly (starts/stops it itself) and talks to it
over stdin — no RCON, nothing extra to enable in `server.properties`.

## Requirements

- Node.js 18+
- Linux (stats read `/proc`; backups shell out to `tar`)
- Java already installed and able to run your server jar
- `tar` on PATH

## Setup

1. **Install dependencies**

   ```bash
   npm install
   ```

2. **Edit `config/config.yml`**

   ```yaml
   panel:
     bind: "127.0.0.1"
     port: 8080
     sessionSecret: "CHANGE_ME_TO_A_RANDOM_STRING"   # change this

   server:
     type: "paper"                  # or "velocity"
     directory: "/path/to/your/server"   # absolute path, contains the server jar
     jarFile: "paper.jar"           # or "velocity.jar"
     javaBin: "java"
     javaArgs:
       - "-Xms4G"
       - "-Xmx8G"
     extraArgs:
       - "nogui"
   ```

   Nothing needs to change in `server.properties` or `velocity.toml` —
   RCON isn't used, so `enable-rcon` can stay off.

   Optional, fill in later if you use them:
   - `sftp.*` — display-only info shown in the SFTP Info tab
   - `backups.include` — paths to include in backups (defaults assume
     Paper's world folders; for Velocity use something like
     `["velocity.toml", "forwarding.secret", "plugins"]`)
   - `server.bridgeStatsFile` — only relevant if you install the optional
     Vexium Bridge plugin for live TPS/MSPT (Paper only, see `/plugin`)

3. **Create your first administrator**

   ```bash
   node scripts/add-user.js adrian owner
   ```

   Prompts for a password (hidden input), hashes it, and appends the
   account to `config/users.yml`. Roles: `owner`, `admin`, `moderator`.

4. **Start the panel**

   ```bash
   npm start
   ```

   Open `http://127.0.0.1:8080` (or whatever `panel.bind`/`panel.port`
   you set) and sign in with the account from step 3.

5. **(Optional) Keep it running across reboots**

   The panel owns the java process — if the panel stops, the server
   stops. Run it under systemd or `pm2` if you want it to survive a
   reboot:

   ```bash
   pm2 start src/server.js --name vexium-panel
   ```

That's the whole setup. Everything below is reference, not required reading.

---

## Velocity instead of Paper

Set `server.type: "velocity"` and point `server.directory`/`jarFile` at
your Velocity install. This automatically changes: the stop command
(`shutdown` instead of `stop`), which config file gets edited (`velocity.toml`
instead of `server.properties`), the Plugin Installer's Hangar platform,
and Player Manager (shows raw `glist all` output instead of a managed
table, since Velocity has no ops/whitelist/ban files of its own).

## Optional: live TPS/MSPT

Without any extra setup, the Dashboard's TPS card just says "Not
installed." To populate it, build and install the small companion plugin
in `/plugin` (needs a JDK + Maven + internet access on whatever machine
you build it on — see `plugin/README.md`). It writes
`plugins/VexiumBridge/stats.json` every 5 seconds; the panel reads that
file instead of sending console commands. Paper only.

## Notes / limitations

- The panel must be running for the server to be running (see step 5 above).
- Command "responses" (Player Manager actions, anything typed in the
  Console tab) are a best-effort capture of console output right after a
  command is sent, not a guaranteed request/response — see
  `src/processManager.js` if you want the details. TPS/MSPT doesn't have
  this problem since it reads from a file instead.
- Sessions are in-memory — restarting the panel logs everyone out.
- File manager, backups, and plugin installs are scoped to
  `server.directory`/`backups.directory`/`plugins/`, but any signed-in
  admin can edit any file the panel can see — there's no per-role file
  restriction yet.
- To hand-edit `config/users.yml` instead of using the UI, use
  `node scripts/add-user.js` so the password gets bcrypt-hashed properly
  — never write a plaintext password into that file.

## Project layout

```
config/
  config.yml        # server path, java args, sftp info, server.type
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
  stats.js          # /proc-based CPU/mem sampling + bridge-file reading
  routes/           # one file per API area
public/
  index.html        # the panel UI (single file, no build step)
scripts/
  add-user.js       # CLI to add an admin account
plugin/
  pom.xml           # Maven build for the optional Vexium Bridge plugin
  src/              # plugin source — see plugin/README.md to build/install
```
