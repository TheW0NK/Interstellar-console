# Interstellar Console

Interstellar Console is a Linux-first executable control panel for a local Paper server. The Go backend serves the existing `console.html`, generates its own configuration on first boot, starts `server.jar` as a child process, sends commands through RCON, streams Paper output to the browser, handles uploads inside the server folder, installs Paper plugins from Modrinth, creates backups, and writes audit logs.

## Requirements

- Linux VPS or Linux home server.
- Java installed and available as `java`.
- A Paper server jar named `server.jar` by default.
- Go only if you are building from source.
- Port `36688/tcp` open if you want to access the panel remotely.

## Recommended folder layout

Place the console executable beside your Paper server files:

```text
/srv/vexium/
├─ vexium-console
├─ console.html
├─ server.jar
├─ server.properties
├─ plugins/
├─ backups/
├─ logs/
├─ world/
├─ world_nether/
└─ world_the_end/
```

The generated `config.json` uses the folder containing the executable as the managed content root by default.

## Build from source

From the repository root:

```bash
go build -o vexium-console ./cmd/vexium-console
```

For a smaller Linux amd64 binary:

```bash
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o vexium-console ./cmd/vexium-console
```

For Linux arm64:

```bash
CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -trimpath -ldflags="-s -w" -o vexium-console ./cmd/vexium-console
```

## Install into your server folder

```bash
sudo mkdir -p /srv/vexium
sudo cp vexium-console console.html /srv/vexium/
sudo cp server.jar /srv/vexium/
sudo chown -R minecraft:minecraft /srv/vexium
sudo chmod +x /srv/vexium/vexium-console
```

Use a dedicated `minecraft` user when possible. Avoid running a web console as root unless you fully understand the risk.

## First run

```bash
cd /srv/vexium
./vexium-console
```

On first launch the app creates `config.json`, creates an initial owner account named `Adrian_`, and prints the generated password to the terminal. Save that password immediately.

The panel listens on:

```text
http://0.0.0.0:36688
```

Open it from your browser:

```text
http://YOUR_SERVER_IP:36688
```

HTTPS is not enabled yet. Use a VPN, firewall, or reverse proxy if exposing this outside your LAN.

## Firewall

If you use UFW:

```bash
sudo ufw allow 36688/tcp
```

Do not expose RCON publicly. The console config defaults RCON to `127.0.0.1:25575`.

## Paper / RCON integration

When you click **Start**, the console:

1. Writes `eula.txt` if configured.
2. Auto-updates `server.properties` with:
   - `enable-rcon=true`
   - `rcon.port=<configured port>`
   - `rcon.password=<generated password>`
3. Runs `java -jar server.jar nogui` as a child process.
4. Streams stdout/stderr to the browser.

If Paper was started outside the panel, the backend scans `/proc` for the configured `server.processMatch` value and can still show the server as online. In that case, logs fall back to tailing `logs/latest.log`.

## Configuration

Edit `config.json` after the first run. Important fields:

```json
{
  "port": 36688,
  "contentRoot": ".",
  "server": {
    "jar": "server.jar",
    "javaPath": "java",
    "javaArgs": ["-jar", "server.jar", "nogui"],
    "processMatch": "server.jar",
    "logFile": "logs/latest.log"
  },
  "rcon": {
    "host": "127.0.0.1",
    "port": 25575,
    "password": "generated"
  }
}
```

Restart the console after changing `config.json`.

## Backups

Manual backups call `save-off`, `save-all flush`, archive the configured include paths into `backups/`, then call `save-on`. Existing backups are listed in the Backups tab.

## Modrinth plugin installs

The Plugin Installer searches Modrinth for Paper plugins and downloads the selected `.jar` into `plugins/`. Restart Paper after installing or updating most plugins.

## Run as a systemd service

Copy the included service file and adjust paths/user if needed:

```bash
sudo cp packaging/systemd/vexium-console.service /etc/systemd/system/vexium-console.service
sudo systemctl daemon-reload
sudo systemctl enable vexium-console
sudo systemctl start vexium-console
sudo journalctl -u vexium-console -f
```

## Troubleshooting

### The website still looks offline

Make sure Paper is either started through the panel or the configured `server.processMatch` appears in the Paper process command line:

```bash
ps aux | grep server.jar
```

### Login failed

Use the generated password printed on first run. If lost, stop the console, edit `config.json`, remove the user entry, and restart to generate a fresh config, or add a new hashed user with a future account-management tool.

### Port already in use

```bash
sudo ss -tulpn | grep 36688
```

Change `port` in `config.json` if needed.

### Java not found

```bash
java -version
```

Install Java or set `server.javaPath` in `config.json`.

### RCON failed

Confirm the console started Paper at least once so it can write `server.properties`, then restart Paper. RCON is only available after Paper has fully booted.

### File permissions

Ensure the user running `vexium-console` owns the server folder:

```bash
sudo chown -R minecraft:minecraft /srv/vexium
```
