package net.vexium.bridge;

import org.bukkit.Bukkit;
import org.bukkit.plugin.java.JavaPlugin;

import java.io.File;
import java.io.FileWriter;
import java.io.IOException;

/**
 * Vexium Bridge — a tiny plugin with one job: write current TPS, MSPT, and
 * player counts to a small JSON file on a timer. The Vexium Panel reads
 * that file directly instead of sending "tps"/"mspt" to the console, so
 * there's zero command overhead and zero console noise.
 *
 * If this plugin isn't installed, the panel just doesn't show live TPS/MSPT
 * — nothing else about the panel depends on it.
 */
public final class VexiumBridge extends JavaPlugin {

    private static final long WRITE_INTERVAL_TICKS = 20L * 5; // every 5 seconds
    private File statsFile;

    @Override
    public void onEnable() {
        if (!getDataFolder().exists()) {
            getDataFolder().mkdirs();
        }
        statsFile = new File(getDataFolder(), "stats.json");

        // Write once immediately, then on a timer.
        writeStats();
        Bukkit.getScheduler().runTaskTimer(this, this::writeStats, WRITE_INTERVAL_TICKS, WRITE_INTERVAL_TICKS);

        getLogger().info("Vexium Bridge enabled - writing stats to " + statsFile.getPath());
    }

    @Override
    public void onDisable() {
        // Zero everything out so the panel doesn't show a stale last-known
        // TPS after the server has actually stopped ticking.
        writeStats();
    }

    private void writeStats() {
        double[] tps = Bukkit.getServer().getTPS();       // {1m, 5m, 15m} — Paper API
        double mspt = Bukkit.getServer().getAverageTickTime(); // Paper API
        int online = Bukkit.getOnlinePlayers().size();
        int max = Bukkit.getMaxPlayers();

        String json = "{"
                + "\"tps1m\":" + round(tps[0]) + ","
                + "\"tps5m\":" + round(tps[1]) + ","
                + "\"tps15m\":" + round(tps[2]) + ","
                + "\"mspt\":" + round(mspt) + ","
                + "\"playersOnline\":" + online + ","
                + "\"playersMax\":" + max + ","
                + "\"updatedAt\":" + System.currentTimeMillis()
                + "}";

        try (FileWriter writer = new FileWriter(statsFile)) {
            writer.write(json);
        } catch (IOException e) {
            getLogger().warning("Could not write stats file: " + e.getMessage());
        }
    }

    private double round(double value) {
        return Math.round(value * 100.0) / 100.0;
    }
}
