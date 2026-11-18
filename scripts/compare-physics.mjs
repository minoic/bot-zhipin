import { readFile } from 'node:fs/promises';

/** @typedef {{relativeMs:number,x:number,y:number,z:number}} Sample */
/** @typedef {{schemaVersion:number,fixtureId:string,inputSignature:unknown[],source?:string,samples:Sample[]}} Capture */
/** @typedef {{a:Sample,b:Sample}} Aligned */

const [botPath, vanillaPath] = process.argv.slice(2);
if (!botPath || !vanillaPath) {
  throw new Error(
    'Usage: node scripts/compare-physics.mjs <bot-capture.json> <vanilla-capture.json>',
  );
}
const [bot, vanilla] = await Promise.all([load(botPath), load(vanillaPath)]);
validateCapture('bot', bot);
validateCapture('vanilla', vanilla);
if (
  bot.fixtureId !== vanilla.fixtureId ||
  JSON.stringify(bot.inputSignature) !== JSON.stringify(vanilla.inputSignature)
) {
  throw new Error('captures must use the same fixtureId and inputSignature');
}
const aligned = align(bot.samples, vanilla.samples);
if (!aligned.length)
  throw new Error(
    'no aligned timestamp samples; provide samples with a shared relativeMs timeline',
  );
const errors = aligned.map(({ a, b }) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z));
const summary = {
  schemaVersion: 1,
  fixtureId: bot.fixtureId,
  inputSignature: bot.inputSignature,
  sampleCount: aligned.length,
  positionErrorBlocks: {
    mean: mean(errors),
    median: quantile(errors, 0.5),
    p95: quantile(errors, 0.95),
    max: Math.max(...errors),
  },
  provenance: { bot: bot.source, vanilla: vanilla.source },
};
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);

/** @param {string} path @returns {Promise<Capture>} */
async function load(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}
/** @param {string} label @param {Capture} capture */
function validateCapture(label, capture) {
  if (capture.schemaVersion !== 1 || !Array.isArray(capture.samples) || !capture.samples.length) {
    throw new Error(`${label} capture must have schemaVersion:1 and non-empty samples`);
  }
  if (!capture.fixtureId || !Array.isArray(capture.inputSignature))
    throw new Error(`${label} capture needs fixtureId and inputSignature`);
}
/** @param {Sample[]} a @param {Sample[]} b @returns {Aligned[]} */
function align(a, b) {
  const byTime = new Map(
    b.filter((s) => Number.isFinite(s.relativeMs)).map((s) => [s.relativeMs, s]),
  );
  return a.flatMap((sample) => {
    const match = byTime.get(sample.relativeMs);
    return match && [sample.x, sample.y, sample.z, match.x, match.y, match.z].every(Number.isFinite)
      ? [{ a: sample, b: match }]
      : [];
  });
}
/** @param {number[]} values */
function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
/** @param {number[]} values @param {number} p */
function quantile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(p * sorted.length) - 1];
}
