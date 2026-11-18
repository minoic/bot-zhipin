/** Inputs used to rank a task for the next execution slot. */
export type Candidate = {
  id: string;
  capability: string;
  resources: string[];
  preconditions: string[];
  priority: number;
  progress: number;
  urgency: number;
  confidence: number;
  time: number;
  risk: number;
  switchingCost: number;
  preemptible: boolean;
};
export class UtilitySelector {
  #current: string | undefined;
  #currentScore = -Infinity;
  #since = 0;
  #holdMs: number;
  #hysteresis: number;
  constructor(opts: { holdMs?: number; hysteresis?: number } = {}) {
    this.#holdMs = opts.holdMs ?? 500;
    this.#hysteresis = opts.hysteresis ?? 0.1;
  }
  choose(
    candidates: Candidate[],
    caps: ReadonlySet<string>,
    satisfied: ReadonlySet<string>,
    now = Date.now(),
    forced = false,
  ) {
    const eligible = candidates.filter(
      (c) => caps.has(c.capability) && c.preconditions.every((p) => satisfied.has(p)),
    );
    const scored = eligible
      .map((c) => ({
        candidate: c,
        score: c.progress + c.urgency + c.confidence - c.time - c.risk - c.switchingCost,
      }))
      .sort(
        (a, b) =>
          b.candidate.priority - a.candidate.priority ||
          b.score - a.score ||
          a.candidate.id.localeCompare(b.candidate.id),
      );
    const best = scored[0];
    if (!best) return undefined;
    const existing = scored.find((x) => x.candidate.id === this.#current);
    if (existing && existing.candidate.id !== best.candidate.id && !forced) {
      if (
        !existing.candidate.preemptible ||
        (existing.candidate.priority === best.candidate.priority &&
          (now - this.#since < this.#holdMs || best.score < existing.score + this.#hysteresis))
      ) {
        this.#currentScore = existing.score;
        return existing.candidate;
      }
    }
    if (this.#current !== best.candidate.id) {
      this.#current = best.candidate.id;
      this.#since = now;
    }
    this.#currentScore = best.score;
    return best.candidate;
  }
  clear(): void {
    this.#current = undefined;
    this.#currentScore = -Infinity;
    this.#since = 0;
  }
}
