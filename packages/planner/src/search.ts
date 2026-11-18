import type { PlanResult, Vec3 } from '../../contracts/src/index.js';

type Block = { name: string; solid: boolean; revision: number };
export type SearchInput = {
  start: Vec3;
  goal: Vec3;
  blocks: Record<string, Block>;
  maxExpansions: number;
  deadlineEpochMs: number;
};
const empty = (status: PlanResult['status'], expansions = 0): PlanResult => ({
  status,
  path: [],
  dependencies: {},
  expansions,
  cost: 0,
});

export function search(input: SearchInput): PlanResult {
  const deadline = performance.now() + Math.max(0, input.deadlineEpochMs - Date.now());
  const key = (x: number, y: number, z: number) => `${x},${y},${z}`;
  const point = (key: string): Vec3 => {
    const [x, y, z] = key.split(',').map(Number);
    return { x: x!, y: y!, z: z! };
  };
  const heuristic = (a: Vec3, b: Vec3) => Math.abs(a.x - b.x) + Math.abs(a.z - b.z);
  // Only full support blocks and air clearance are supported by this flat-ground planner.
  // Names marked unsupported by the observer are deliberately rejected too.
  const walkable = (p: Vec3) => {
    const floor = input.blocks[key(p.x, p.y - 1, p.z)];
    const feet = input.blocks[key(p.x, p.y, p.z)];
    const head = input.blocks[key(p.x, p.y + 1, p.z)];
    const unsafe = (b: Block | undefined) =>
      !b || /(?:slab|stairs|water|lava|unsupported:)/i.test(b.name);
    return (
      !unsafe(floor) &&
      !unsafe(feet) &&
      !unsafe(head) &&
      floor!.solid &&
      !feet!.solid &&
      !head!.solid
    );
  };
  const start = {
    x: Math.floor(input.start.x),
    y: Math.floor(input.start.y),
    z: Math.floor(input.start.z),
  };
  const goal = {
    x: Math.floor(input.goal.x),
    y: Math.floor(input.goal.y),
    z: Math.floor(input.goal.z),
  };
  // Missing cells are unknown. The baseline only plans level movement on known flat ground.
  if (!walkable(start) || !walkable(goal) || start.y !== goal.y) return empty('unreachable');
  const open: { node: string; f: number }[] = [];
  const less = (a: { node: string; f: number }, b: { node: string; f: number }) =>
    a.f < b.f || (a.f === b.f && a.node <= b.node);
  const push = (v: { node: string; f: number }) => {
    let i = open.length;
    open.push(v);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (less(open[p]!, v)) break;
      open[i] = open[p]!;
      i = p;
    }
    open[i] = v;
  };
  const pop = () => {
    const first = open[0]!,
      last = open.pop()!;
    if (open.length) {
      let i = 0;
      while (true) {
        const l = i * 2 + 1;
        if (l >= open.length) break;
        const r = l + 1,
          c = r < open.length && less(open[r]!, open[l]!) ? r : l;
        if (less(last, open[c]!)) break;
        open[i] = open[c]!;
        i = c;
      }
      open[i] = last;
    }
    return first;
  };
  const sk = key(start.x, start.y, start.z),
    gk = key(goal.x, goal.y, goal.z);
  const came = new Map<string, string>(),
    g = new Map([[sk, 0]]),
    bestF = new Map([[sk, heuristic(start, goal)]]),
    closed = new Set<string>();
  push({ node: sk, f: heuristic(start, goal) });
  let expansions = 0;
  while (open.length) {
    if (expansions >= input.maxExpansions || performance.now() >= deadline)
      return empty('budget-exhausted', expansions);
    const cur = pop()!;
    if (closed.has(cur.node) || cur.f !== bestF.get(cur.node)) continue;
    if (cur.node === gk) {
      const path: Vec3[] = [goal];
      let k = cur.node;
      while (came.has(k)) {
        k = came.get(k)!;
        path.push(point(k));
      }
      path.reverse();
      for (const p of path) {
        p.x += 0.5;
        p.z += 0.5;
      }
      const dependencies: Record<string, number> = {};
      for (const p of path)
        for (const y of [p.y - 1, p.y, p.y + 1]) {
          const k = key(Math.floor(p.x), y, Math.floor(p.z)),
            b = input.blocks[k];
          if (b) dependencies[k] = b.revision;
        }
      return {
        status: 'found',
        path,
        dependencies,
        expansions,
        cost: g.get(gk) ?? 0,
      };
    }
    closed.add(cur.node);
    expansions++;
    const p = point(cur.node);
    for (const [dx, dz] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const n = { x: p.x + dx, y: p.y, z: p.z + dz };
      if (!walkable(n)) continue;
      const nk = key(n.x, n.y, n.z);
      if (closed.has(nk)) continue;
      const tentative = (g.get(cur.node) ?? Infinity) + 1;
      if (tentative >= (g.get(nk) ?? Infinity)) continue;
      came.set(nk, cur.node);
      g.set(nk, tentative);
      const f = tentative + heuristic(n, goal);
      bestF.set(nk, f);
      push({ node: nk, f });
    }
  }
  return empty('unreachable', expansions);
}
