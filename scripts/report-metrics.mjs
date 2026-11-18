import { readFile, writeFile } from 'node:fs/promises';

/** @typedef {{at:number,type:string,payload?:Record<string, unknown>}} Event */

const file = process.argv[2];
if (!file) throw new Error('Usage: node scripts/report-metrics.mjs <events.ndjson> [report.json]');
const text = await readFile(file, 'utf8');
const rows = text
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line, index) => {
    try {
      /** @type {Event} */
      const event = JSON.parse(line);
      return event;
    } catch (error) {
      throw new Error(`Invalid JSON at line ${index + 1}: ${String(error)}`);
    }
  });
/** @type {Event[]} */
const events = rows.filter((row) => row && Number.isFinite(row.at) && typeof row.type === 'string');
/** @param {string} suffix */
const of = (suffix) => events.filter((event) => event.type.endsWith(suffix));
const probes = of('paper.probe.completed');
const plans = of('planner.completed');
const interactions = of('interaction.completed');
const decisions = of('decision.selected');
const cancellations = of('controller.cancelled');
const tickValues = probes.flatMap((probe) => {
  const tick = probe.payload?.tickIntervalMs;
  return isRecord(tick) && isFiniteNumber(tick.p95) ? [tick.p95] : [];
});
/** @param {number} part @param {number} whole */
const percent = (part, whole) => (whole ? part / whole : null);
/** @param {number[]} values */
const avg = (values) =>
  values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const report = {
  schemaVersion: 1,
  source: file,
  eventCount: events.length,
  observed: {
    probeRuns: probes.length,
    connectMsMedian: median(probes.map((p) => p.payload?.connectMs).filter(isFiniteNumber)),
    clientTickIntervalP95MedianMs: median(tickValues),
    planningCount: plans.length,
    planningMsMean: avg(plans.map((e) => e.payload?.durationMs).filter(isFiniteNumber)),
    interactionCount: interactions.length,
    interactionConfirmedRate: percent(
      interactions.filter(
        (e) => e.payload?.status === 'observed' || e.payload?.status === 'confirmed',
      ).length,
      interactions.length,
    ),
    selectedDecisionCount: decisions.length,
    cancellations: cancellations.length,
  },
  unavailable: [
    'server-side tick rate and position correction require independent Paper observer events',
    'vanilla client baseline requires an imported capture from the same fixture and inputs',
    'RTT/jitter groups require explicit network-condition metadata; client tick timing is not RTT',
    'success rate requires scenario start and independently verified terminal outcome events',
    'model latency, token use and cost require provider response events with usage metadata',
  ],
};
const output = process.argv[3];
if (output) await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
else process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

/** @param {number[]} values */
function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const center = sorted[middle];
  if (center === undefined) return null;
  if (sorted.length % 2) return center;
  const lower = sorted[middle - 1];
  return lower === undefined ? center : (lower + center) / 2;
}

/** @param {unknown} value @returns {value is number} */
function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
