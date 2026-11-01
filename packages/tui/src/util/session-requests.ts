import { createMemo, mapArray, type Accessor } from "solid-js"

/**
 * Reactively aggregates items across a dynamic list of session IDs,
 * memoizing the items per session ID via `mapArray` so that mutations
 * or additions to one child do not cause quadratic recalculation across all children.
 */
export function createSessionRequests<T>(
  sessionIDs: Accessor<readonly string[]>,
  list: (sessionID: string) => readonly T[] | undefined,
): Accessor<T[]> {
  const requests = mapArray(sessionIDs, (sessionID) => {
    return createMemo(() => list(sessionID) ?? [])
  })
  return createMemo(() => requests().flatMap((items) => items()))
}
