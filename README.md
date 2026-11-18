# Development setup

Requirements: Docker Desktop with Linux containers, Node.js 24.x, and pnpm 10.28.2. Use `npx --yes --package=node@24.19.0 --package=pnpm@10.28.2 pnpm <command>` if those runtimes are not installed system-wide; run `install --frozen-lockfile`, then `typecheck` and `test`. `.node-version` is also honored by Node version managers.

For package responsibilities, code layout, and formatting commands, see [the maintenance guide](docs/maintenance.md).

## Runtime and commands

`pnpm bot:demo -- "navigate to 4 1 0"` runs a deterministic offline fixture through the goal, plan, controller and simulated observation path. It does not validate Minecraft physics or online actions. `BOT_DB_PATH` changes the SQLite path from `.data/minecraft-bot.sqlite`; set `BOT_LOG_PATH` to record NDJSON alongside it.

The connected entry point is `node --env-file-if-exists=.env --import tsx apps/bot/src/main.ts online`. Run it from the repository root with Node 24, set `BOT_USERNAME` and use a controlled server. It imports nearby loaded terrain and exposes local terminal commands:

- `/goal <natural language goal>` submits a goal; `/status` displays its ID, revision and state.
- `/stop` cancels active, queued and clarification-pending goals locally.
- `/replace [--goal <goalId>] <natural language goal>` replaces a goal. When multiple goals are active, the ID is required.
- `/clarify <goalId> <revision> <answer>` answers the current clarification; stale revisions are rejected.

The first skills target known, loaded, level terrain: `navigate` and `openContainer`. Unsupported terrain and unknown blocks are not treated as traversable. Goal completion depends on runtime observations and skill evidence. Online movement, interaction, cancellation, reconciliation and recovery have not been accepted against a Paper fixture in this change; do not interpret the offline demo or simulated tests as proof of real-server behavior.

Configuration is read from process environment. Copy `.env.example` to `.env` for the explicit Node command above; files are not searched implicitly. `LLM_PROVIDER` defaults to `offline`. For `openai-compatible`, set `LLM_BASE_URL`, `LLM_API_KEY` and `LLM_MODEL`; all are required and a missing value fails startup. The adapter uses the OpenAI Chat Completions JSON-mode protocol; compatibility with other services or models is not established. Defaults are a 10-second timeout, eight attempts per goal and one concurrent request. Do not put credentials in logs or source control.

The memory API stores events in SQLite WAL mode. The NDJSON writer accepts caller-owned sequence and monotonic time so both stores can share the same event identity; it reports backpressure and a missed event means the NDJSON recording is incomplete. `replayDecision` reconstructs recorded goal, plan and task state from validated model responses and recorded events without invoking a model or performing game actions. It does not independently prove that the original actions or goal observations occurred, nor does it recover events that were never recorded. Deterministic algorithm recomputation remains a separate replay operation.
## Start Paper

`docker compose -f compose.yaml up -d` starts Paper Minecraft 26.1.2 (the latest published 26.1 patch) on `127.0.0.1:25565` with Java 25. The compose file accepts Minecraft's EULA for this local test instance and disables online authentication so the locally named smoke bot can connect. Keep the server local. World data persists in ignored `server-data/`; the seed is fixed at 261026. PaperMC does not publish an exact `26.1` build (`version_not_found` from its official API), so this setup pins the latest patch in that protocol family: Paper `26.1.2`, build `74`, SHA-256 `1d70b1dab9cf4a6de615209a536f3a45a2186240253c428213ce2188ab95e5f7`. The server image is pinned to the Linux amd64 manifest digest in Compose.

Wait for readiness with `docker compose -f compose.yaml ps` (healthy), inspect logs with `docker compose -f compose.yaml logs -f paper`, then run the smoke check with the command above and `smoke:paper`. It verifies two logins across reconnect, spawn, loaded terrain, 26.1 registry, inventory API access, and physics ticks. It does not validate movement or interactions.

## Acceptance captures

Run `node scripts/acceptance-paper.mjs` (or `pnpm exec node scripts/acceptance-paper.mjs`) against the local server for repeatable login, spawn, loaded-column, inventory, client physics-tick interval, and reconnect observations. Set `PROBE_REPEATS` (1–50), `PROBE_SETTLE_MS`, `PAPER_HOST`, `PAPER_PORT`, and `BOT_USERNAME` to configure the capture. Output is NDJSON with a run ID and monotonic process time; capture it with your shell's output redirection when you need an artifact. The physics interval is Mineflayer's local event cadence, not a measured Paper tick rate or RTT.

For a second client observing server-replicated player positions, run `node scripts/observe-paper.mjs` with `OBSERVE_USERNAME=<subject>` and optional `OBSERVE_DURATION_MS`. This is a separate protocol observer, not an authoritative Paper plugin or vanilla-client ground truth. Movement, correction, and physics comparisons need matching fixture/input captures from the bot, an independent Paper sampler, and an unmodified Java client.

To collect authoritative server-side samples on this local test server, build the optional plugin with Java 25 and Gradle (`gradle -p infra/paper-probe build`), copy `infra/paper-probe/build/libs/bot-probe-paper-0.1.0.jar` to `server-data/plugins/BotProbe-0.1.0.jar`, then restart Paper. It records join/quit and per-server-tick player location/velocity to `server-data/plugins/BotProbe/observations.ndjson` through a bounded asynchronous file queue. It samples every online player and logs one warning if the queue fills; use it only for controlled acceptance runs. It is not exposed to the bot. Source/build artifacts are provided, but this environment's Java 17 runtime cannot compile the Java 25 plugin, and the plugin was not installed on the running server.

Import those vanilla-client measurements as JSON with `schemaVersion: 1`, `fixtureId`, `inputSignature`, `source`, and `samples: [{relativeMs,x,y,z}]`; use exactly matching `relativeMs` sample times for both captures. Run `node scripts/compare-physics.mjs bot-capture.json vanilla-capture.json` to report position-error mean, median, p95, and maximum. No baseline values are bundled or inferred. Run `node scripts/report-metrics.mjs events.ndjson [report.json]` for metrics supported by observed NDJSON events; metrics that need unavailable independent evidence are explicitly listed as unavailable. RTT/jitter runs must carry their network condition as metadata in the source capture before comparing groups.

To connect an idle Mineflayer bot, run `npx --yes --package=node@24.19.0 --package=pnpm@10.28.2 pnpm idle:paper`. It connects as `IdleBot`, clears all movement controls on spawn, and stays connected until stopped with Ctrl+C. Set `BOT_USERNAME` to use a different offline name.

Stop with `docker compose -f compose.yaml down`; world data remains in `server-data/`. Remove that directory only when you want a fresh world. Paper build selection follows the pinned 26.1.2 Paper build 74; review the startup log before replacing the container image or world data after a Paper build update.

## MCP server

This workspace installs `yuniko-software/minecraft-mcp-server` at commit `240c8cec337ce152cc9e058ebdef511055808406` (Apache-2.0), built as a pinned pnpm Git dependency. Codex uses the project-scoped stdio entry in `.codex/config.toml`, which launches bot `MCPBot` against the local Paper server. Codex loads project MCP configuration only for a trusted workspace; no global Codex configuration is changed.

The upstream README documents support through Minecraft 1.21.11. The locked Mineflayer 4.39.0 auto-detected Paper 26.1.2 (protocol 26.1), and an MCP client round-trip verified initialization, tool listing, and read-only `get-position`. This does not establish support for every upstream tool on 26.1. Run `pnpm smoke:mcp` to repeat the stdio check with bot name `MCPBotTest`; the upstream server also sends its built-in ready message when its bot spawns.



