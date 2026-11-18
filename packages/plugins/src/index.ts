import { z } from 'zod';
import type {
  BotPlugin,
  PluginContext,
  PluginManifest,
  Snapshot,
} from '../../contracts/src/index.js';

const ManifestSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
  apiVersion: z.literal(1),
  capabilities: z.array(z.string()).max(64),
  subscriptions: z.array(z.string()).max(64),
});
export class PluginHost {
  #allowlist: Set<string>;
  #available: ReadonlySet<string>;
  #plugins = new Map<
    string,
    {
      plugin: BotPlugin;
      controller: AbortController;
      unsubscribe: Array<() => void>;
    }
  >();
  #ctx: PluginContext;
  constructor(opts: {
    allowlist: string[];
    capabilities: ReadonlySet<string>;
    snapshot: () => Snapshot;
    submitGoal: PluginContext['submitGoal'];
    onResult?: (listener: (result: unknown) => void) => () => void;
  }) {
    this.#allowlist = new Set(opts.allowlist);
    this.#available = opts.capabilities;
    this.#ctx = {
      observe: () => structuredClone(opts.snapshot()),
      submitGoal: opts.submitGoal,
      onResult: opts.onResult ?? (() => () => {}),
    };
  }
  async load(plugin: BotPlugin): Promise<void> {
    const manifest = ManifestSchema.parse(plugin.manifest) as PluginManifest;
    if (!this.#allowlist.has(manifest.id)) throw new Error(`plugin_not_allowlisted:${manifest.id}`);
    if (this.#plugins.has(manifest.id)) throw new Error(`plugin_already_loaded:${manifest.id}`);
    for (const cap of manifest.capabilities)
      if (!this.#available.has(cap)) throw new Error(`plugin_capability_missing:${cap}`);
    const controller = new AbortController(),
      unsubscribes: Array<() => void> = [],
      ctx: PluginContext = {
        observe: () => {
          if (controller.signal.aborted) throw new Error('plugin_unloaded');
          return this.#ctx.observe();
        },
        submitGoal: (goal) => {
          if (controller.signal.aborted)
            return Promise.resolve({
              accepted: false,
              reason: 'plugin_unloaded',
            });
          return this.#ctx.submitGoal(goal);
        },
        onResult: (listener) => {
          if (controller.signal.aborted) return () => {};
          const off = this.#ctx.onResult(listener);
          let active = true;
          const wrapped = () => {
            if (!active) return;
            active = false;
            const index = unsubscribes.indexOf(wrapped);
            if (index >= 0) unsubscribes.splice(index, 1);
            off();
          };
          unsubscribes.push(wrapped);
          return wrapped;
        },
      };
    const entry = { plugin, controller, unsubscribe: unsubscribes };
    this.#plugins.set(manifest.id, entry);
    try {
      await plugin.start(ctx, controller.signal);
    } catch (error) {
      controller.abort();
      for (const off of [...unsubscribes]) off();
      if (this.#plugins.get(manifest.id) === entry) this.#plugins.delete(manifest.id);
      throw error;
    }
  }
  async unload(id: string): Promise<boolean> {
    const entry = this.#plugins.get(id);
    if (!entry) return false;
    this.#plugins.delete(id);
    entry.controller.abort();
    for (const off of [...entry.unsubscribe]) off();
    return true;
  }
  async close(): Promise<void> {
    for (const id of this.#plugins.keys()) await this.unload(id);
  }
  get loaded() {
    return [...this.#plugins.keys()];
  }
}
