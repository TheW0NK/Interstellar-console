# Interstellar Console

A Linux-first executable control panel for a local Paper server. The Go backend serves the existing `console.html`, generates its own configuration on first boot, starts `server.jar` as a child process, sends commands through RCON, streams Paper process output to the browser, handles uploads inside the server folder, installs Paper plugins from Modrinth, creates backups, and writes audit logs.

## Build

```bash
go build -o vexium-console ./cmd/vexium-console
```

## Run

Place the executable next to `console.html` and `server.jar`, then run:

```bash
./vexium-console
```

On first launch the app writes `config.json`, creates an initial owner account, and prints the generated password to the terminal. The panel listens on `http://0.0.0.0:36688` by default.

## Paper integration

When the server is started, the executable auto-updates `server.properties` with RCON settings, accepts the EULA when configured, and launches `server.jar` as a child process. Stop and restart actions send RCON commands to the local Paper server.

## Security notes

All file operations are resolved through the configured content root and cannot intentionally escape that folder. Run this as a dedicated server user instead of root when possible.
