import type { Observation, Snapshot, Vec3 } from '../../contracts/src/index.js';
import { ObservationSchema, VectorSchema } from '../../contracts/src/index.js';
import { z } from 'zod';

const blockKey = (x: number, y: number, z: number) =>
  `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`;
export class WorldModel {
  #epoch = 0;
  #dimension = 'minecraft:overworld';
  #revision = 0;
  #seq = -1;
  #blocks = new Map<string, { name: string; solid: boolean; revision: number }>();
  #entities = new Map<number, { position: Vec3; velocity: Vec3; observedAt: number }>();
  #position: Vec3 = { x: 0, y: 0, z: 0 };
  #inventoryRevision = 0;
  #inventory: unknown[] = [];
  #allowServer: boolean;
  constructor(opts: { allowServerObservations?: boolean } = {}) {
    this.#allowServer = opts.allowServerObservations ?? false;
  }
  get revision() {
    return this.#revision;
  }
  ingest(event: Observation): boolean {
    const parsed = ObservationSchema.safeParse(event);
    if (!parsed.success || (event.source === 'server' && !this.#allowServer)) return false;
    if (!event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload))
      return false;
    const p = event.payload as Record<string, any>;
    if (event.type === 'position' && !VectorSchema.safeParse(p.position).success) return false;
    if (
      event.type === 'block' &&
      (!VectorSchema.safeParse(p.position).success ||
        typeof p.name !== 'string' ||
        typeof p.solid !== 'boolean')
    )
      return false;
    if (
      event.type === 'entity' &&
      (!Number.isInteger(p.id) || !VectorSchema.safeParse(p.position).success)
    )
      return false;
    if (
      event.sessionEpoch < this.#epoch ||
      (event.seq <= this.#seq && event.sessionEpoch === this.#epoch)
    )
      return false;
    if (event.sessionEpoch > this.#epoch || event.dimension !== this.#dimension) {
      this.#epoch = event.sessionEpoch;
      this.#dimension = event.dimension;
      this.#seq = -1;
      this.#blocks.clear();
      this.#entities.clear();
      this.#position = { x: 0, y: 0, z: 0 };
      this.#inventoryRevision = 0;
      this.#inventory = [];
      this.#revision++;
    }
    this.#seq = event.seq;
    if (event.type === 'position' && p.position) {
      this.#position = { x: p.position.x, y: p.position.y, z: p.position.z };
    } else if (event.type === 'block' && p.position) {
      const k = blockKey(p.position.x, p.position.y, p.position.z);
      const old = this.#blocks.get(k);
      if (old && old.name === p.name && old.solid === p.solid) return true;
      this.#blocks.set(k, {
        name: String(p.name),
        solid: Boolean(p.solid),
        revision: ++this.#revision,
      });
    } else if (event.type === 'blockUnload' && p.position) {
      this.#blocks.delete(blockKey(p.position.x, p.position.y, p.position.z));
      this.#revision++;
    } else if (event.type === 'chunkUnload' && Number.isInteger(p.x) && Number.isInteger(p.z)) {
      for (const key of this.#blocks.keys()) {
        const [x, , z] = key.split(',').map(Number);
        if (Math.floor(x! / 16) === p.x && Math.floor(z! / 16) === p.z) this.#blocks.delete(key);
      }
      this.#revision++;
    } else if (event.type === 'inventory') {
      this.#inventoryRevision++;
      if (Array.isArray(p.slots)) this.#inventory = structuredClone(p.slots);
    } else if (event.type === 'entity' && Number.isInteger(p.id) && p.position) {
      const old = this.#entities.get(p.id);
      const dt = old ? Math.max(0.001, (event.observedAt - old.observedAt) / 1000) : 1;
      const measured = old
        ? {
            x: (p.position.x - old.position.x) / dt,
            y: (p.position.y - old.position.y) / dt,
            z: (p.position.z - old.position.z) / dt,
          }
        : { x: 0, y: 0, z: 0 };
      const teleport = !old || dt > 2 || Math.hypot(measured.x, measured.y, measured.z) > 20;
      const velocity = teleport
        ? { x: 0, y: 0, z: 0 }
        : {
            x: 0.35 * measured.x + 0.65 * old.velocity.x,
            y: 0.35 * measured.y + 0.65 * old.velocity.y,
            z: 0.35 * measured.z + 0.65 * old.velocity.z,
          };
      this.#entities.set(p.id, {
        position: { ...p.position },
        velocity,
        observedAt: event.observedAt,
      });
    } else if (event.type === 'entityGone') this.#entities.delete(p.id);
    return true;
  }
  observeMineflayer(bot: any, now = Date.now()): void {
    const point = bot.entity?.position;
    if (point) {
      const position = { x: point.x, y: point.y, z: point.z };
      if (VectorSchema.safeParse(position).success) this.#position = position;
    }
    if (Array.isArray(bot.inventory?.slots)) this.#inventoryRevision++;
    void now;
  }
  setBlock(position: Vec3, name: string, solid: boolean): void {
    VectorSchema.parse(position);
    this.#blocks.set(blockKey(position.x, position.y, position.z), {
      name,
      solid,
      revision: ++this.#revision,
    });
  }
  predictEntity(id: number, now = Date.now(), maxAgeMs = 500): Vec3 | undefined {
    const entity = this.#entities.get(id);
    if (!entity) return undefined;
    const age = Math.max(0, now - entity.observedAt);
    if (age > maxAgeMs) return undefined;
    const seconds = age / 1000;
    return {
      x: entity.position.x + entity.velocity.x * seconds,
      y: entity.position.y + entity.velocity.y * seconds,
      z: entity.position.z + entity.velocity.z * seconds,
    };
  }
  block(x: number, y: number, z: number) {
    const key = blockKey(x, y, z);
    return this.#blocks.has(key) ? this.#blocks.get(key) : undefined;
  }
  snapshot(): Snapshot {
    return {
      sessionEpoch: this.#epoch,
      dimension: this.#dimension,
      revision: this.#revision,
      blocks: new Map([...this.#blocks].map(([k, v]) => [k, { ...v }])),
      entities: new Map(
        [...this.#entities].map(([k, v]) => [
          k,
          { ...v, position: { ...v.position }, velocity: { ...v.velocity } },
        ]),
      ),
      position: { ...this.#position },
      inventoryRevision: this.#inventoryRevision,
      inventory: structuredClone(this.#inventory),
    };
  }
  dependenciesValid(deps: Record<string, number>): boolean {
    for (const [key, revision] of Object.entries(deps))
      if (this.#blocks.get(key)?.revision !== revision) return false;
    return true;
  }
  raycast(from: Vec3, to: Vec3): { visible: boolean; hit?: Vec3; unknown?: Vec3 } {
    const d = { x: to.x - from.x, y: to.y - from.y, z: to.z - from.z };
    const cell = {
      x: Math.floor(from.x),
      y: Math.floor(from.y),
      z: Math.floor(from.z),
    };
    const end = {
      x: Math.floor(to.x),
      y: Math.floor(to.y),
      z: Math.floor(to.z),
    };
    const step = { x: Math.sign(d.x), y: Math.sign(d.y), z: Math.sign(d.z) };
    const delta = {
      x: d.x === 0 ? Infinity : Math.abs(1 / d.x),
      y: d.y === 0 ? Infinity : Math.abs(1 / d.y),
      z: d.z === 0 ? Infinity : Math.abs(1 / d.z),
    };
    const max = {
      x: d.x === 0 ? Infinity : ((step.x > 0 ? cell.x + 1 : cell.x) - from.x) / d.x,
      y: d.y === 0 ? Infinity : ((step.y > 0 ? cell.y + 1 : cell.y) - from.y) / d.y,
      z: d.z === 0 ? Infinity : ((step.z > 0 ? cell.z + 1 : cell.z) - from.z) / d.z,
    };
    for (let i = 0; i < 4096; i++) {
      if (cell.x === end.x && cell.y === end.y && cell.z === end.z) return { visible: true };
      const b = this.#blocks.get(`${cell.x},${cell.y},${cell.z}`);
      if (!b) return { visible: false, unknown: { x: cell.x, y: cell.y, z: cell.z } };
      if (b.solid) return { visible: false, hit: { x: cell.x, y: cell.y, z: cell.z } };
      if (max.x <= max.y && max.x <= max.z) {
        cell.x += step.x;
        max.x += delta.x;
      } else if (max.y <= max.z) {
        cell.y += step.y;
        max.y += delta.y;
      } else {
        cell.z += step.z;
        max.z += delta.z;
      }
    }
    return { visible: false, unknown: { ...cell } };
  }
}
