# Vexium Bridge (optional companion plugin)

A ~60-line plugin with one job: write live TPS/MSPT/player counts to
`plugins/VexiumBridge/stats.json` every 5 seconds. The panel reads that
file directly instead of typing `tps`/`mspt` into the console, so there's
no command overhead and no console spam.

**This is optional.** Without it, the panel's TPS/MSPT card just shows
"Not installed" and everything else works exactly the same.

## Build it

You'll need a JDK 17+ and Maven, and this step needs internet access (to
pull the Paper API from PaperMC's Maven repo) — do this on your own
machine, not on the server if it's air-gapped:

```bash
cd plugin
mvn package
```

This produces `target/VexiumBridge.jar`.

If your server is running a Paper build far newer or older than the
`paper-api` version pinned in `pom.xml`, bump that version number to
something closer to what you're running before building — the two methods
this plugin actually calls (`getTPS()`, `getAverageTickTime()`) have been
stable in the Paper API for a long time, so an exact version match usually
isn't necessary.

## Install it

Drop `VexiumBridge.jar` into your server's `plugins/` folder (the File
Manager tab in the panel works fine for this) and restart the server, or
run `reload confirm` from the Console tab. Once it's running, the panel's
TPS/MSPT card should populate within ~5 seconds.

## Uninstall it

Delete the jar from `plugins/` and restart. The panel falls back to
"Not installed" automatically — nothing else needs to change.
