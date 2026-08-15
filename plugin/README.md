# Vexium Bridge (optional companion plugin)

A ~60-line plugin with one job: write live TPS/MSPT/player counts to
`plugins/VexiumBridge/stats.json` every 5 seconds. The panel reads that
file directly instead of typing `tps`/`mspt` into the console, so there's
no command overhead and no console spam.

**This is optional.** Without it, the panel's TPS/MSPT card just shows
"Not installed" and everything else works exactly the same.

## Option A: use the pre-built jar

`dist/VexiumBridge-1.0.0.jar` is included, ready to drop into `plugins/`.

**How it was actually built, and what that does/doesn't prove:** this was
compiled with `javac` directly against hand-written stub classes whose
method signatures were written to match the real Bukkit/Paper API exactly
(`Bukkit.getServer()`, `Server.getTPS()`, `Server.getAverageTickTime()`,
`Bukkit.getScheduler().runTaskTimer(...)`, `Bukkit.getOnlinePlayers()`,
`Bukkit.getMaxPlayers()`, `JavaPlugin.getDataFolder()`/`getLogger()`) —
not a real Maven build against the actual `paper-api` artifact, because
Maven Central and PaperMC's repo weren't reachable from where this was
built. The stub classes themselves are never bundled into the jar (verify
with `unzip -l VexiumBridge-1.0.0.jar` — only `plugin.yml` and
`net/vexium/bridge/VexiumBridge.class`), and disassembling the compiled
class (`javap -c`) confirms every `org.bukkit.*` method call in the
bytecode has the exact same name and type descriptor as the real API, so
a real server's classloader should resolve them correctly at runtime — the
JVM doesn't care which jar a class *came from* originally, only that the
name and signature match. The onEnable/onDisable/writeStats logic was
also executed end-to-end against those same stubs and produces correctly
shaped JSON.

**What this doesn't prove:** it has never actually run inside a real Paper
server process. If you'd rather not trust a jar built this way, build it
yourself with real Maven — see Option B.

## Option B: build it yourself with Maven

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
something closer to what you're running before building — the methods
this plugin actually calls have been stable in the Paper API for a long
time, so an exact version match usually isn't necessary.

## Install it

Drop the jar (from either option) into your server's `plugins/` folder
(the File Manager tab in the panel works fine for this) and restart the
server, or run `reload confirm` from the Console tab. Once it's running,
the panel's TPS/MSPT card should populate within ~5 seconds.

## Uninstall it

Delete the jar from `plugins/` and restart. The panel falls back to
"Not installed" automatically — nothing else needs to change.
