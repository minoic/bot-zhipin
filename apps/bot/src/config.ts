export type BotConfig = {
  provider: 'offline' | 'openai-compatible';
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  requestTimeoutMs: number;
  maxCallsPerGoal: number;
  maxConcurrentRequests: number;
};

/** Read explicit process environment only. The caller chooses the Node --env-file path. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): BotConfig {
  const provider = env.LLM_PROVIDER || 'offline';
  if (provider !== 'offline' && provider !== 'openai-compatible')
    throw new Error('invalid_llm_provider');
  const integer = (name: string, fallback: number): number => {
    const raw = env[name];
    if (raw === undefined || raw === '') return fallback;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`invalid_config:${name}`);
    return value;
  };
  const requestTimeoutMs = integer('LLM_REQUEST_TIMEOUT_MS', 10_000);
  const maxCallsPerGoal = integer('LLM_MAX_CALLS_PER_GOAL', 8);
  const maxConcurrentRequests = integer('LLM_MAX_CONCURRENT_REQUESTS', 1);
  if (maxConcurrentRequests !== 1) throw new Error('invalid_config:LLM_MAX_CONCURRENT_REQUESTS');
  if (provider === 'offline')
    return { provider, requestTimeoutMs, maxCallsPerGoal, maxConcurrentRequests };
  const baseUrl = env.LLM_BASE_URL?.trim(),
    apiKey = env.LLM_API_KEY?.trim(),
    model = env.LLM_MODEL?.trim();
  if (!baseUrl || !apiKey || !model)
    throw new Error('openai-compatible requires LLM_BASE_URL, LLM_API_KEY and LLM_MODEL');
  let url: URL;
  try {
    url = new URL(baseUrl);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error();
  } catch {
    throw new Error('invalid_config:LLM_BASE_URL');
  }
  return {
    provider,
    baseUrl,
    apiKey,
    model,
    requestTimeoutMs,
    maxCallsPerGoal,
    maxConcurrentRequests,
  };
}
