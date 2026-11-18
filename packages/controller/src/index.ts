import {
  InputFrameSchema,
  LeaseSchema,
  ObservationSchema,
  type ClientDriver,
  type ControlLease,
  type InputFrame,
  type Outcome,
  type Vec3,
} from '../../contracts/src/index.js';

type Revocation = { lease: ControlLease; reason: 'preempted' | 'expired' | 'cleared' };
type RevocationListener = (event: Revocation) => void;
const movementKeys = ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak'] as const;

export class LeaseArbiter {
  #current = new Map<string, ControlLease>();
  #generation = 0;
  #listeners = new Set<RevocationListener>();
  #expiryTimer: ReturnType<typeof setTimeout> | undefined;

  onRevoked(listener: RevocationListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  acquire(request: Omit<ControlLease, 'generation'>, now = Date.now()): ControlLease | undefined {
    const resources = [...new Set(request.resources)];
    const candidate = LeaseSchema.safeParse({
      ...request,
      resources,
      generation: this.#generation + 1,
    });
    if (!candidate.success || request.expiresAt <= now) return undefined;

    this.expire(now);
    const conflicts = [...new Set(resources.map((resource) => this.#current.get(resource)))].filter(
      (lease): lease is ControlLease => lease !== undefined,
    );
    if (
      conflicts.some(
        (lease) =>
          lease.owner !== request.owner &&
          (!lease.preemptible || lease.priority >= request.priority),
      )
    ) {
      return undefined;
    }

    const preempted = new Set(conflicts);
    for (const oldLease of preempted) {
      for (const resource of oldLease.resources) {
        if (this.#current.get(resource) === oldLease) this.#current.delete(resource);
      }
    }
    const lease = LeaseSchema.parse({ ...request, resources, generation: ++this.#generation });
    Object.freeze(lease.resources);
    Object.freeze(lease);
    for (const resource of lease.resources) this.#current.set(resource, lease);
    for (const oldLease of preempted) this.#notify({ lease: oldLease, reason: 'preempted' });
    this.#scheduleExpiry(now);
    return lease;
  }

  valid(lease: ControlLease, now = Date.now()): boolean {
    this.expire(now);
    if (
      !LeaseSchema.safeParse(lease).success ||
      lease.resources.length === 0 ||
      lease.expiresAt <= now
    )
      return false;
    return lease.resources.every((resource) => this.#current.get(resource) === lease);
  }

  release(lease: ControlLease): void {
    for (const resource of lease.resources) {
      if (this.#current.get(resource) === lease) this.#current.delete(resource);
    }
    this.#scheduleExpiry(Date.now());
  }

  expire(now = Date.now()): void {
    const expired = new Set([...this.#current.values()].filter((lease) => lease.expiresAt <= now));
    for (const lease of expired) {
      for (const resource of lease.resources) {
        if (this.#current.get(resource) === lease) this.#current.delete(resource);
      }
      this.#notify({ lease, reason: 'expired' });
    }
    this.#scheduleExpiry(now);
  }

  clear(): void {
    const leases = new Set(this.#current.values());
    this.#current.clear();
    this.#generation++;
    this.#clearExpiry();
    for (const lease of leases) this.#notify({ lease, reason: 'cleared' });
  }

  #notify(event: Revocation): void {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {
        /* A cleanup observer must not interrupt atomic lease transfer. */
      }
    }
  }

  #clearExpiry(): void {
    if (this.#expiryTimer) clearTimeout(this.#expiryTimer);
    this.#expiryTimer = undefined;
  }

  #scheduleExpiry(now: number): void {
    this.#clearExpiry();
    const next = Math.min(...[...this.#current.values()].map((lease) => lease.expiresAt));
    if (!Number.isFinite(next)) return;
    this.#expiryTimer = setTimeout(
      () => this.expire(),
      Math.min(2_147_483_647, Math.max(0, next - now)),
    );
    this.#expiryTimer.unref?.();
  }
}

export class MineflayerDriver implements ClientDriver {
  readonly capabilities = new Set(['move', 'look', 'inventory', 'interact', 'navigate']);
  #bot: any;
  #arbiter: LeaseArbiter;
  #listeners = new Set<(event: ReturnType<typeof ObservationSchema.parse>) => void>();
  #epoch = 0;
  #seq = 0;
  #connected = false;
  #tickListeners = new Set<(error?: Error) => void>();
  #removeRevocationListener: () => void;
  #pendingInteraction:
    | { requestId: string; target: Vec3; epoch: number; settled: boolean }
    | undefined;
  #interactionTimeoutMs: number;
  #dimension: string | undefined;
  #importChunk: string | undefined;
  #blockCache = new Map<string, string>();
  #importRunning: Promise<void> | undefined;
  #importAgain = false;
  #importTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(bot: any, arbiter: LeaseArbiter, options: { interactionTimeoutMs?: number } = {}) {
    this.#bot = bot;
    this.#arbiter = arbiter;
    this.#interactionTimeoutMs = options.interactionTimeoutMs ?? 10_000;
    this.#removeRevocationListener = arbiter.onRevoked(({ lease }) =>
      this.#releaseResources(lease.resources),
    );
    bot.on('spawn', () => {
      arbiter.clear();
      this.#epoch++;
      this.#connected = true;
      this.#dimension = bot.game?.dimension;
      this.#importChunk = undefined;
      this.#blockCache.clear();
      this.#importRunning = undefined;
      this.#importAgain = false;
      this.#emit('spawn', {});
      this.synchronizeWindow();
    });
    const reset = () => {
      if (!this.#connected) return;
      this.#connected = false;
      this.#epoch++;
      this.#importChunk = undefined;
      this.#blockCache.clear();
      this.#importRunning = undefined;
      this.#importAgain = false;
      this.#releaseResources(['move']);
      for (const listener of this.#tickListeners) listener(new Error('session_changed'));
      arbiter.clear();
      this.#emit('dimensionReset', {});
    };
    bot.on('respawn', reset);
    bot.on('game', () => {
      if (this.#connected && this.#dimension !== bot.game?.dimension) reset();
    });
    bot.on('physicsTick', () => {
      arbiter.expire();
      this.#emit('tick', { position: this.#position() });
      for (const listener of this.#tickListeners) listener();
    });
    bot.on('move', () => {
      const position = this.#position();
      if (position) {
        this.#emit('position', { position });
        const chunk = `${Math.floor(position.x / 16)},${Math.floor(position.z / 16)},${Math.floor(position.y)}`;
        if (chunk !== this.#importChunk) this.#scheduleImport();
      }
    });
    bot.on('blockUpdate', (_old: unknown, block: any) => {
      if (block?.position) {
        const full =
          Array.isArray(block.shapes) &&
          block.shapes.length === 1 &&
          block.shapes[0].length === 6 &&
          block.shapes[0].every((n: number, i: number) => n === (i < 3 ? 0 : 1));
        const empty =
          Array.isArray(block.shapes) &&
          block.shapes.length === 0 &&
          ['air', 'cave_air', 'void_air'].includes(block.name);
        this.#observeBlock(
          block.position,
          full || empty ? String(block.name) : `unsupported:${String(block.name ?? 'unknown')}`,
          !empty,
        );
      }
    });
    bot.on('health', () => this.#emit('health', { health: bot.health, food: bot.food }));
    bot.on('windowOpen', (window: any) =>
      this.#emit('window', { id: window.id, title: String(window.title ?? '') }),
    );
    bot.on('windowClose', () => this.#emit('windowClosed', {}));
    bot.on('chunkColumnLoad', () => this.#scheduleImport());
    bot.on('chunkColumnUnload', (point: any) => {
      if (point) {
        const cx = Math.floor(point.x / 16),
          cz = Math.floor(point.z / 16);
        for (const key of this.#blockCache.keys()) {
          const [x, , z] = key.split(',').map(Number);
          if (Math.floor(x! / 16) === cx && Math.floor(z! / 16) === cz)
            this.#blockCache.delete(key);
        }
        this.#emit('chunkUnload', { x: Math.floor(point.x / 16), z: Math.floor(point.z / 16) });
      }
    });
    bot.on('entityMoved', (entity: any) => {
      if (entity?.position && Number.isInteger(entity.id))
        this.#emit('entity', {
          id: entity.id,
          position: { x: entity.position.x, y: entity.position.y, z: entity.position.z },
        });
    });
    bot.on('entityGone', (entity: any) => {
      if (Number.isInteger(entity?.id)) this.#emit('entityGone', { id: entity.id });
    });
    bot.on('playerCollect', () => this.#emit('inventory', { slots: this.#inventory() }));
    bot.inventory?.on?.('updateSlot', () => this.#emit('inventory', { slots: this.#inventory() }));
    bot.on('end', () => this.disconnect());
  }

  #inventory(): unknown[] {
    return (this.#bot.inventory?.slots ?? []).map((item: any) =>
      item ? { name: item.name, count: item.count } : null,
    );
  }

  get interactionBarrier():
    | Readonly<{ requestId: string; target: Vec3; epoch: number; settled: boolean }>
    | undefined {
    return this.#pendingInteraction && structuredClone(this.#pendingInteraction);
  }

  /** A current-session window snapshot fences late responses from a prior connection. */
  synchronizeWindow(): boolean {
    if (!this.#connected || !('currentWindow' in this.#bot)) return false;
    const pending = this.#pendingInteraction;
    if (pending && (pending.epoch !== this.#epoch || pending.settled)) {
      this.#emit('interaction.synchronized', {
        requestId: pending.requestId,
        priorEpoch: pending.epoch,
        currentWindowId: this.#bot.currentWindow?.id ?? null,
      });
      this.#pendingInteraction = undefined;
    }
    return true;
  }

  /** Import a bounded horizontal area and the support/clearance layers around the player. */
  #observeBlock(position: Vec3, name: string, solid: boolean): void {
    const key = `${position.x},${position.y},${position.z}`;
    const value = JSON.stringify([name, solid]);
    if (this.#blockCache.get(key) === value) return;
    this.#blockCache.set(key, value);
    this.#emit('block', { position: { x: position.x, y: position.y, z: position.z }, name, solid });
  }

  #scheduleImport(): void {
    if (!this.#connected || this.#importTimer) return;
    this.#importTimer = setTimeout(() => {
      this.#importTimer = undefined;
      void this.importNearby().catch(() =>
        this.#emit('importError', { reason: 'terrain_import_failed' }),
      );
    }, 50);
    this.#importTimer.unref?.();
  }

  importNearby(radius = 16): Promise<void> {
    if (this.#importRunning) {
      this.#importAgain = true;
      return this.#importRunning;
    }
    const task = this.#scanNearby(radius);
    this.#importRunning = task;
    const finish = () => {
      if (this.#importRunning !== task) return;
      this.#importRunning = undefined;
      if (this.#importAgain) {
        this.#importAgain = false;
        this.#scheduleImport();
      }
    };
    void task.then(finish, finish);
    return task;
  }

  async #scanNearby(radius: number): Promise<void> {
    const position = this.#bot.entity?.position;
    if (!this.#connected || !position || typeof this.#bot.blockAt !== 'function') return;
    const limit = Math.max(0, Math.min(32, Math.floor(radius)));
    const epoch = this.#epoch;
    this.#emit('position', { position: { x: position.x, y: position.y, z: position.z } });
    const cx = Math.floor(position.x),
      cy = Math.floor(position.y),
      cz = Math.floor(position.z);
    this.#importChunk = `${Math.floor(position.x / 16)},${Math.floor(position.z / 16)},${cy}`;
    let scanned = 0;
    for (let x = cx - limit; x <= cx + limit; x++)
      for (let z = cz - limit; z <= cz + limit; z++)
        for (let y = cy - 1; y <= cy + 2; y++) {
          if (!this.#connected || this.#epoch !== epoch) return;
          if (++scanned % 128 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
          if (!this.#connected || this.#epoch !== epoch) return;
          const point = new position.constructor(x, y, z);
          const block = this.#bot.blockAt(point);
          if (!block) continue;
          const full =
            Array.isArray(block.shapes) &&
            block.shapes.length === 1 &&
            block.shapes[0].length === 6 &&
            block.shapes[0].every((n: number, i: number) => n === (i < 3 ? 0 : 1));
          const empty =
            Array.isArray(block.shapes) &&
            block.shapes.length === 0 &&
            (block.name === 'air' || block.name === 'cave_air' || block.name === 'void_air');
          const name =
            full || empty ? String(block.name) : `unsupported:${String(block.name ?? 'unknown')}`;
          this.#observeBlock({ x, y, z }, name, full || !empty);
        }
    this.#emit('inventory', { slots: this.#inventory() });
    for (const entity of Object.values(this.#bot.entities ?? {}) as any[]) {
      if (Number.isInteger(entity?.id) && entity.position)
        this.#emit('entity', {
          id: entity.id,
          position: { x: entity.position.x, y: entity.position.y, z: entity.position.z },
        });
    }
  }

  subscribe(emit: (event: ReturnType<typeof ObservationSchema.parse>) => void): () => void {
    this.#listeners.add(emit);
    return () => this.#listeners.delete(emit);
  }

  waitForTick(signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const finish = (error?: Error) => {
        this.#tickListeners.delete(finish);
        signal?.removeEventListener('abort', abort);
        if (error) reject(error);
        else resolve();
      };
      const abort = () => finish(new Error('cancelled'));
      if (signal?.aborted) return abort();
      this.#tickListeners.add(finish);
      signal?.addEventListener('abort', abort, { once: true });
    });
  }

  #position() {
    const position = this.#bot.entity?.position;
    return position && { x: position.x, y: position.y, z: position.z };
  }

  #emit(
    type: string,
    payload: unknown,
    epoch = this.#epoch,
    dimension = this.#bot.game?.dimension ?? 'minecraft:overworld',
  ): void {
    const parsed = ObservationSchema.parse({
      sessionEpoch: epoch,
      dimension: dimension.includes(':') ? dimension : `minecraft:${dimension}`,
      seq: ++this.#seq,
      observedAt: Date.now(),
      source: 'protocol',
      type,
      payload,
    });
    for (const listener of this.#listeners) {
      try {
        listener(parsed);
      } catch {
        /* Observers cannot break the client physics loop. */
      }
    }
  }

  #releaseResources(resources: readonly string[]): void {
    if (resources.includes('move')) {
      for (const key of movementKeys) this.#bot.setControlState?.(key, false);
      this.#bot.clearControlStates?.();
    }
  }

  apply(raw: InputFrame, lease: ControlLease): void {
    if (!this.#connected || !this.#arbiter.valid(lease)) throw new Error('stale_control_lease');
    const frame = InputFrameSchema.parse(raw);
    const requestsMovement = movementKeys.some((key) => frame[key]);
    if (requestsMovement && !lease.resources.includes('move'))
      throw new Error('missing_move_lease');
    if ((frame.yaw !== undefined || frame.pitch !== undefined) && !lease.resources.includes('look'))
      throw new Error('missing_look_lease');
    if (frame.slot !== undefined && !lease.resources.includes('inventory'))
      throw new Error('missing_inventory_lease');

    if (lease.resources.includes('move')) {
      for (const key of movementKeys) this.#bot.setControlState(key, frame[key]);
    }
    if (lease.resources.includes('look') && frame.yaw !== undefined) {
      this.#bot.look(frame.yaw, frame.pitch ?? this.#bot.entity.pitch, true);
    }
    if (lease.resources.includes('inventory') && frame.slot !== undefined)
      this.#bot.setQuickBarSlot(frame.slot);
  }

  async interact(
    request: { requestId: string; target: { x: number; y: number; z: number }; action: string },
    lease: ControlLease,
  ): Promise<Outcome> {
    if (!this.#connected || !this.#arbiter.valid(lease))
      return { status: 'rejected', requestId: request.requestId, reason: 'stale_control_lease' };
    if (!lease.resources.includes('interact'))
      return { status: 'rejected', requestId: request.requestId, reason: 'missing_interact_lease' };
    if (request.action !== 'openContainer')
      return { status: 'rejected', requestId: request.requestId, reason: 'unsupported_action' };
    if (this.#pendingInteraction)
      return {
        status: 'uncertain',
        requestId: request.requestId,
        reason: 'interaction_already_pending',
      };
    if (![request.target.x, request.target.y, request.target.z].every(Number.isFinite))
      return { status: 'rejected', requestId: request.requestId, reason: 'invalid_target' };

    const position = this.#bot.entity?.position;
    if (!position)
      return { status: 'rejected', requestId: request.requestId, reason: 'player_not_spawned' };
    const distance = Math.hypot(
      position.x - (request.target.x + 0.5),
      position.y + 1.62 - (request.target.y + 0.5),
      position.z - (request.target.z + 0.5),
    );
    if (distance > 4.5)
      return { status: 'rejected', requestId: request.requestId, reason: 'target_out_of_reach' };
    const target = new position.constructor(request.target.x, request.target.y, request.target.z);
    const block = this.#bot.blockAt(target);
    if (!block || block.boundingBox === 'empty' || !this.#bot.canSeeBlock(block)) {
      return { status: 'rejected', requestId: request.requestId, reason: 'target_not_visible' };
    }
    if (
      !/^(?:chest|trapped_chest|ender_chest|barrel|hopper|dispenser|dropper|(?:[a-z_]+_)?shulker_box)$/.test(
        String(block.name),
      )
    )
      return { status: 'rejected', requestId: request.requestId, reason: 'target_not_container' };
    if (!this.#arbiter.valid(lease))
      return { status: 'rejected', requestId: request.requestId, reason: 'stale_control_lease' };

    const token = {
      requestId: request.requestId,
      target: { ...request.target },
      epoch: this.#epoch,
      settled: false,
    };
    const epoch = this.#epoch;
    const dimension = this.#bot.game?.dimension ?? 'minecraft:overworld';
    this.#pendingInteraction = token;
    this.#emit('interaction.submitted', {
      requestId: request.requestId,
      target: token.target,
      sessionEpoch: epoch,
    });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const opening = Promise.resolve(this.#bot.openContainer(block));
      void opening.then(
        (window: any) => {
          token.settled = true;
          this.#emit(
            'interaction.observedOpen',
            {
              requestId: token.requestId,
              target: token.target,
              sessionEpoch: epoch,
              windowId: window.id,
            },
            epoch,
            dimension,
          );
          if (this.#pendingInteraction === token && this.#epoch === epoch) this.synchronizeWindow();
        },
        () => {
          token.settled = true;
          this.#emit(
            'interaction.settled',
            {
              requestId: token.requestId,
              target: token.target,
              sessionEpoch: epoch,
            },
            epoch,
            dimension,
          );
          if (this.#pendingInteraction === token && this.#epoch === epoch) this.synchronizeWindow();
        },
      );
      const outcome = await Promise.race([
        opening.then(
          (window) => ({
            status: 'observed' as const,
            evidence: {
              windowId: window.id,
              title: String(window.title ?? ''),
              block: block.name,
              target: token.target,
              sessionEpoch: epoch,
              requestId: request.requestId,
            },
          }),
          () => ({
            status: 'uncertain' as const,
            reason: 'interaction_driver_error',
          }),
        ),
        new Promise<{ status: 'uncertain'; reason: string }>((resolve) => {
          timeout = setTimeout(
            () => resolve({ status: 'uncertain', reason: 'interaction_timed_out_pending' }),
            this.#interactionTimeoutMs,
          );
          timeout.unref?.();
        }),
      ]);
      if (this.#epoch !== epoch || !this.#connected)
        return {
          status: 'uncertain',
          requestId: request.requestId,
          reason: 'session_changed_after_submit',
        };
      if (outcome.status === 'uncertain')
        this.#emit('interaction.uncertain', {
          requestId: token.requestId,
          target: token.target,
          sessionEpoch: epoch,
          reason: outcome.reason,
        });
      return { ...outcome, requestId: request.requestId };
    } catch {
      token.settled = true;
      this.synchronizeWindow();
      return {
        status: 'uncertain',
        requestId: request.requestId,
        reason: 'interaction_driver_error',
      };
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  releaseInputs(): void {
    this.#releaseResources(['move']);
  }

  disconnect(): void {
    this.#releaseResources(['move']);
    this.#connected = false;
    this.#importRunning = undefined;
    this.#importAgain = false;
    if (this.#importTimer) clearTimeout(this.#importTimer);
    this.#importTimer = undefined;
    this.#blockCache.clear();
    this.#epoch++;
    for (const listener of this.#tickListeners) listener(new Error('disconnected'));
    this.#arbiter.clear();
    this.#emit('disconnect', {});
  }
}

export class ActionController {
  #driver: ClientDriver;
  #arbiter: LeaseArbiter;
  #epoch = 0;

  constructor(driver: ClientDriver, arbiter: LeaseArbiter) {
    this.#driver = driver;
    this.#arbiter = arbiter;
  }

  get sessionEpoch(): number {
    return this.#epoch;
  }

  resetSession(): void {
    this.#epoch++;
    this.#arbiter.clear();
    this.#driver.releaseInputs();
  }

  async interact(
    request: { requestId: string; target: Vec3; action: string },
    opts: { owner: string; priority: number; signal?: AbortSignal; epoch?: number; ttlMs?: number },
  ): Promise<Outcome> {
    if (opts.signal?.aborted || (opts.epoch !== undefined && opts.epoch !== this.#epoch))
      return { status: 'rejected', requestId: request.requestId, reason: 'cancelled' };
    const lease = this.#arbiter.acquire({
      owner: opts.owner,
      priority: opts.priority,
      preemptible: true,
      resources: ['interact'],
      expiresAt: Date.now() + (opts.ttlMs ?? 30_000),
    });
    if (!lease)
      return { status: 'rejected', requestId: request.requestId, reason: 'lease_unavailable' };
    let abort: (() => void) | undefined;
    let unwatch: (() => void) | undefined;
    try {
      const cancelled = new Promise<Outcome>((resolve) => {
        abort = () =>
          resolve({
            status: 'uncertain',
            requestId: request.requestId,
            reason: 'cancelled_after_submit',
          });
        opts.signal?.addEventListener('abort', abort, { once: true });
        unwatch = this.#arbiter.onRevoked((event) => {
          if (event.lease === lease) abort?.();
        });
      });
      const result = await Promise.race([this.#driver.interact(request, lease), cancelled]);
      if (opts.signal?.aborted || (opts.epoch !== undefined && opts.epoch !== this.#epoch))
        return {
          status: 'uncertain',
          requestId: request.requestId,
          reason: 'cancelled_after_submit',
        };
      return result;
    } finally {
      if (abort) opts.signal?.removeEventListener('abort', abort);
      unwatch?.();
      this.#arbiter.release(lease);
    }
  }

  async runFrames(
    frames: InputFrame[],
    opts: {
      owner: string;
      priority: number;
      preemptible: boolean;
      resources?: string[];
      ttlMs?: number;
      signal?: AbortSignal;
      epoch?: number;
      onFrame?: (i: number) => void;
      tickMs?: number;
    },
  ): Promise<{ completed: number; reason?: string }> {
    if (opts.signal?.aborted) return { completed: 0, reason: 'cancelled' };
    const epoch = opts.epoch ?? this.#epoch;
    const lease = this.#arbiter.acquire({
      owner: opts.owner,
      priority: opts.priority,
      preemptible: opts.preemptible,
      resources: opts.resources ?? ['move', 'look'],
      expiresAt: Date.now() + (opts.ttlMs ?? 30_000),
    });
    if (!lease) return { completed: 0, reason: 'lease_unavailable' };

    const abort = new AbortController();
    const relayAbort = () => abort.abort(opts.signal?.reason);
    opts.signal?.addEventListener('abort', relayAbort, { once: true });
    const removeRevocationListener = this.#arbiter.onRevoked((event) => {
      if (event.lease === lease) abort.abort(event.reason);
    });
    let completed = 0;
    try {
      for (const frame of frames) {
        if (epoch !== this.#epoch) return { completed, reason: 'session_changed' };
        if (abort.signal.aborted) return { completed, reason: 'cancelled' };
        if (!this.#arbiter.valid(lease)) return { completed, reason: 'lease_revoked' };
        this.#driver.apply(frame, lease);
        opts.onFrame?.(completed);
        completed++;
        const tickDriver = this.#driver as ClientDriver & {
          waitForTick?: (signal?: AbortSignal) => Promise<void>;
        };
        if (tickDriver.waitForTick) await tickDriver.waitForTick(abort.signal);
        else await new Promise((resolve) => setTimeout(resolve, opts.tickMs ?? 50));
      }
      return { completed };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const reason =
        message === 'disconnected' ? 'disconnected' : abort.signal.aborted ? 'cancelled' : message;
      return { completed, reason };
    } finally {
      opts.signal?.removeEventListener('abort', relayAbort);
      removeRevocationListener();
      const stillOwner = this.#arbiter.valid(lease);
      this.#arbiter.release(lease);
      if (stillOwner) this.#driver.releaseInputs();
    }
  }
}
