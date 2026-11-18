# Implementation status

## Implemented in source

- Model adapters include a deterministic offline provider and an OpenAI Chat Completions JSON-mode provider. Configuration defaults to offline, requires explicit remote settings and applies a 10-second default request deadline and eight-attempt goal budget. The coordinator validates model output, isolates request scopes, supports cancellation and limits retries and format repair.
- The decision runtime includes a skill registry, atomic task-plan validation, goal and task versions, priority selection, cancellation and runtime goal-evidence checks. The online entry point exposes local goal, status, stop, replace and revision-bound clarification commands.
- The online source includes loaded-world observation, flat-ground navigation and container interaction with an uncertainty barrier. These are restricted to the supported terrain and must not be treated as a full collision or physics model.
- SQLite WAL persistence and NDJSON recording share caller-supplied event sequence and monotonic time. The NDJSON queue is bounded and reports backpressure; missed records make a recording incomplete. The pure `replayDecision` reconstructs state from recorded events and validated model responses, while deterministic recomputation is a separate API.
- The optional Paper sampler remains separate from bot decision inputs. The 30-request catalog tests classification and is not a movement acceptance trial.

## Verification in this change

- On 2026-11-18, a local Paper connection-only check remained connected for 65 seconds and shut down normally; Paper reported a normal disconnect and no keepalive timeout. The session recorded 4,430 block observations and 1,285 ticks over 64.4 seconds, versus 730,534 block observations and 3 ticks in the earlier timed-out session. That run exposed three missing final NDJSON events during shutdown. After the shutdown fix, a separate short connection exited with code 0 and no stderr; SQLite and NDJSON each contained 7,546 events with matching final stop and disconnect events. Neither check submitted a goal, moved or interacted, or called a real model.
- On 2026-11-18, Node 24.22.1 passed the project TypeScript check (`tsc --noEmit`), the full Vitest suite (12 files, 90/90 tests) and the full configured Prettier check. Because pnpm was not on the default PATH, the project-local tsc, Vitest and Prettier entry points were invoked directly with Node 24 using the arguments from the package scripts.
- Mock HTTP tests cover authentication, rate limits, retries, output repair, budget, scope isolation, cancellation and timeout. Replay tests cover caller-owned sequence/time, backpressure retry, validated responses, task/goal event ordering and rejection of stale outcomes. These are local tests, not a real model API or Paper online acceptance result.

## Unverified or incomplete

- No real model request was made. No service or model is claimed to have passed live API integration.
- No online movement or interaction was run for this change. The required local Paper fixture, ten navigation trials, ten navigation-plus-container trials and control/interaction-isolation acceptance cases have not been collected. Source implementation and offline tests do not establish the required online success rate.
- Replay can only reconstruct events actually recorded. Recording backpressure currently reports a missing NDJSON event; a partial event stream is not a complete replay. Scheduling/recovery event coverage should be audited against the acceptance plan before declaring replay complete.
- Full collision-shape/AABB modeling, non-level terrain, physics calibration, independent Paper sampling and a vanilla-client baseline remain outside the first supported movement scope. The Paper sampler was not built or installed in the earlier environment, which had Java 17 rather than the required Java 25.
- No RTT/jitter matrix, repeated movement trial, Paper correction-rate sample, or real-model latency/cost benchmark has been collected. The previous Paper login/terrain/inventory smoke established connectivity only and does not validate this change's navigation or interactions.
