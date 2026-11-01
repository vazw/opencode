import type { SessionMessageInfo } from "@opencode/client"

type MessageChild = {
  readonly id?: string
  readonly y: number
}

export function messageNavigationSlack(input: {
  top: number
  viewportHeight: number
  scrollHeight: number
  currentSlack: number
}) {
  const contentHeight = input.scrollHeight - input.currentSlack
  return Math.max(0, Math.ceil(input.top + input.viewportHeight - contentHeight))
}

export type ScrollRestoreStep =
  | { action: "scroll"; scrollTop: number }
  | { action: "grow-slack"; slack: number }
  | { action: "grow-rows" }
  | { action: "retry" }
  | { action: "settle" }
  | { action: "give-up" }

/**
 * One step of a bounded, convergent transcript-anchor restore.
 *
 * Contract: `target` is the content-space position that puts the anchored renderable back at
 * `anchor.screenY`. `boundary` is true only when that renderable is registered *and* laid out
 * (`node.height > 0`); when it is false `target` is unused. `settle` is returned only when
 * `scrollTop === target` and `target <= maximum`, so the anchor is applied rather than merely
 * requested.
 *
 * Invariant: every attempt either resolves the boundary, grows the mounted row window (monotone
 * toward `rows.length`), grows the navigation slack to exactly the deficit, scrolls to a reachable
 * target, or exhausts `maxAttempts`. `messageNavigationSlack` is idempotent in `currentSlack`, so
 * the attempt after `grow-slack` satisfies `target <= maximum`, and no branch can revisit a
 * geometry it has already seen. Worst case is 7 returned actions — retry, grow-rows, grow-slack,
 * scroll, grow-slack, scroll, settle — against the caller's ceiling of 8.
 *
 * `viewportHeight === 0` leaves `maximum === scrollHeight`, so a positive target takes the slack
 * branch instead of dividing by zero.
 */
export function scrollRestoreStep(input: {
  target: number
  scrollTop: number
  scrollHeight: number
  viewportHeight: number
  currentSlack: number
  boundary: boolean
  moreRows: boolean
  attempts: number
  maxAttempts: number
}): ScrollRestoreStep {
  if (!input.boundary) return input.attempts < input.maxAttempts ? { action: "retry" } : { action: "give-up" }
  const maximum = Math.max(0, input.scrollHeight - input.viewportHeight)
  if (input.target > maximum && input.moreRows) return { action: "grow-rows" }
  if (input.target > maximum) {
    const slack = messageNavigationSlack({
      top: input.target,
      viewportHeight: input.viewportHeight,
      scrollHeight: input.scrollHeight,
      currentSlack: input.currentSlack,
    })
    if (slack === input.currentSlack) return input.attempts < input.maxAttempts ? { action: "retry" } : { action: "give-up" }
    return { action: "grow-slack", slack }
  }
  if (input.scrollTop !== input.target) return { action: "scroll", scrollTop: input.target }
  return { action: "settle" }
}

export function findMessageBoundary(input: {
  direction: "next" | "prev"
  children: readonly MessageChild[]
  messages: readonly SessionMessageInfo[]
  scrollTop: number
  viewportY: number
  currentID?: string
  userOnly?: boolean
}) {
  const messages = new Map(input.messages.map((message) => [message.id, message]))
  const visible = input.children
    .flatMap((child) => {
      if (!child.id) return []
      const message = messages.get(child.id)
      if (!message) return []
      if (message.type === "user" && message.text.trim()) {
        const y = input.scrollTop + child.y - input.viewportY
        return [{ id: child.id, y, top: y }]
      }
      if (input.userOnly || message.type !== "assistant") return []
      if (!message.content.some((content) => content.type === "text" && content.text.trim())) return []
      const y = input.scrollTop + child.y - input.viewportY
      return [{ id: child.id, y, top: Math.max(0, y - 1) }]
    })
    .sort((a, b) => a.y - b.y)

  const current = visible.findIndex((child) => child.id === input.currentID)
  if (current !== -1) return visible[current + (input.direction === "next" ? 1 : -1)] ?? null
  if (input.direction === "next") return visible.find((child) => child.y > input.scrollTop) ?? null
  return visible.findLast((child) => child.y < input.scrollTop) ?? null
}
