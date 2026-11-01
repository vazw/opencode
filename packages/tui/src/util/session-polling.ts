/**
 * Narrows a session family to the members a permission or form request can still appear on.
 * A subagent that finished its run and holds no request cannot ask again until it runs, so a
 * long session must not spend a request and a memo on every one of its hundreds of children.
 */
export function pollableSessionIDs(input: {
  /** Always kept, in this order: the routed session and any open tab roots. */
  include: readonly string[]
  /** Candidates, newest first (the `family()` index order). */
  candidates: readonly string[]
  /** Sessions with a live execution: the `Data["session"]["active"]()` snapshot. */
  running: readonly string[]
  /** Sessions already holding a pending permission or form in the client store. */
  pending: readonly string[]
  /** Session info lookup; must be read untracked by the caller. */
  info: (sessionID: string) => { readonly time: { readonly idle?: unknown } } | undefined
  /** Speculative tail over children neither running nor known idle. Default 5. */
  limit?: number
}): string[] {
  const limit = input.limit ?? 5
  const running = new Set(input.running)
  const pending = new Set(input.pending)
  const kept = new Set<string>()
  const output: string[] = []
  const push = (sessionID: string) => {
    if (kept.has(sessionID)) return
    kept.add(sessionID)
    output.push(sessionID)
  }
  for (const sessionID of input.include) push(sessionID)
  // Live work always reaches the prompt, however many children the family holds.
  for (const sessionID of input.candidates) if (running.has(sessionID)) push(sessionID)
  for (const sessionID of input.candidates) if (pending.has(sessionID)) push(sessionID)
  let speculative = 0
  for (const [index, sessionID] of input.candidates.entries()) {
    if (speculative >= limit) break
    if (kept.has(sessionID)) continue
    // A child with no completed run may be starting right now; the newest few are worth a look.
    if (index < limit || input.info(sessionID)?.time.idle === undefined) {
      push(sessionID)
      speculative++
    }
  }
  return output
}
