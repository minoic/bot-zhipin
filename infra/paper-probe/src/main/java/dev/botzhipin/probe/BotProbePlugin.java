package dev.botzhipin.probe;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import org.bukkit.Bukkit;
import org.bukkit.Location;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.Listener;
import org.bukkit.event.player.PlayerJoinEvent;
import org.bukkit.event.player.PlayerQuitEvent;
import org.bukkit.plugin.java.JavaPlugin;

import java.io.BufferedWriter;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.AbstractMap;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/** Test-server-only authoritative sampler. It never exposes data to the bot. */
public final class BotProbePlugin extends JavaPlugin implements Listener {
    private static final Gson JSON = new GsonBuilder().disableHtmlEscaping().create();
    private final BlockingQueue<String> lines = new LinkedBlockingQueue<>(16_384);
    private final AtomicBoolean running = new AtomicBoolean();
    private long serverTick;
    private Thread writer;
    private boolean warnedQueueFull;

    @Override
    public void onEnable() {
        running.set(true);
        Bukkit.getPluginManager().registerEvents(this, this);
        writer = new Thread(this::writeLoop, "bot-probe-ndjson-writer");
        writer.setDaemon(true);
        writer.start();
        getServer().getScheduler().runTaskTimer(this, () -> {
            serverTick++;
            long now = System.nanoTime();
            for (Player player : Bukkit.getOnlinePlayers()) {
                Location location = player.getLocation();
                offer("paper.player.sample", Map.ofEntries(
                        entry("serverTick", serverTick), entry("observedAtNanos", now),
                        entry("playerUuid", player.getUniqueId().toString()), entry("username", player.getName()),
                        entry("world", location.getWorld().getKey().toString()),
                        entry("x", location.getX()), entry("y", location.getY()), entry("z", location.getZ()),
                        entry("yaw", location.getYaw()), entry("pitch", location.getPitch()),
                        entry("onGround", player.isOnGround()),
                        entry("velocityX", player.getVelocity().getX()), entry("velocityY", player.getVelocity().getY()),
                        entry("velocityZ", player.getVelocity().getZ())));
            }
        }, 1L, 1L);
        getLogger().info("Authoritative sampler enabled; output: plugins/BotProbe/observations.ndjson");
    }

    @EventHandler
    public void onJoin(PlayerJoinEvent event) {
        Player player = event.getPlayer();
        offer("paper.player.join", Map.of("serverTick", serverTick, "observedAtNanos", System.nanoTime(), "playerUuid", player.getUniqueId().toString(), "username", player.getName()));
    }

    @EventHandler
    public void onQuit(PlayerQuitEvent event) {
        Player player = event.getPlayer();
        offer("paper.player.quit", Map.of("serverTick", serverTick, "observedAtNanos", System.nanoTime(), "playerUuid", player.getUniqueId().toString(), "username", player.getName()));
    }

    @Override
    public void onDisable() {
        running.set(false);
        if (writer == null) return;
        try {
            writer.join(3_000);
        } catch (InterruptedException exception) {
            Thread.currentThread().interrupt();
        }
    }

    private void offer(String type, Map<String, ?> payload) {
        String line = JSON.toJson(Map.of("schemaVersion", 1, "source", "paper-server-authoritative", "type", type, "payload", payload));
        if (!lines.offer(line) && !warnedQueueFull) {
            warnedQueueFull = true;
            getLogger().warning("Sampler queue full; observations are being dropped");
        }
    }

    private static Map.Entry<String, Object> entry(String key, Object value) {
        return new AbstractMap.SimpleImmutableEntry<>(key, value);
    }

    private void writeLoop() {
        Path output = getDataFolder().toPath().resolve("observations.ndjson");
        try {
            Files.createDirectories(output.getParent());
            try (BufferedWriter file = Files.newBufferedWriter(output, StandardOpenOption.CREATE, StandardOpenOption.APPEND)) {
                while (running.get() || !lines.isEmpty()) {
                    List<String> batch = new ArrayList<>(512);
                    String first = lines.poll(200, TimeUnit.MILLISECONDS);
                    if (first != null) batch.add(first);
                    lines.drainTo(batch, 511);
                    for (String line : batch) {
                        file.write(line);
                        file.newLine();
                    }
                    if (!batch.isEmpty()) file.flush();
                }
            }
        } catch (InterruptedException exception) {
            if (running.get()) Thread.currentThread().interrupt();
        } catch (IOException exception) {
            getLogger().severe("Could not write authoritative sample: " + exception.getMessage());
        }
    }
}
