/** Deterministic classification for fixed request phrases. */
export function classifyRequestText(text: string): 'clarify' | 'accept' | 'reject' | 'replan' {
  const value = text.trim().toLowerCase();
  if (
    /old position|old session|non-preemptible occupied|owns container|expired observation/.test(
      value,
    )
  )
    return 'reject';
  if (
    /expired route|block changed|snapshot|obstacle|dimension changed|connection dropped|entity entered|support block|stale|observation/.test(
      value,
    )
  )
    return 'replan';
  if (/somewhere|some resources|that place|over there|usual thing/.test(value)) return 'clarify';
  if (
    /\bstop\b|cancel previous|change target|actually|new target|navigate to|head to|preempt lower|atomically|channel is free/.test(
      value,
    )
  )
    return 'accept';
  return 'clarify';
}
