import { expect, test } from "bun:test"
import type { SessionMessageAssistant, SessionMessageInfo } from "@opencode/client"
import {
  findMessageBoundary,
  messageNavigationSlack,
  scrollRestoreStep,
  type ScrollRestoreStep,
} from "../../../src/routes/session/message-navigation"

const messages: SessionMessageInfo[] = [
  { type: "user", id: "user-1", text: "First", time: { created: 0 } },
  assistant("assistant-1", "Response"),
  { type: "user", id: "user-2", text: "Second", time: { created: 2 } },
]
const children = [
  { id: "user-1", y: 0 },
  { id: "assistant-1", y: 20 },
  { id: "user-2", y: 40 },
]

test("adds only enough slack to align the selected message", () => {
  expect(messageNavigationSlack({ top: 80, viewportHeight: 50, scrollHeight: 100, currentSlack: 0 })).toBe(30)
  expect(messageNavigationSlack({ top: 20, viewportHeight: 50, scrollHeight: 130, currentSlack: 30 })).toBe(0)
})

test("finds the next user message without stopping at an assistant message", () => {
  expect(
    findMessageBoundary({
      direction: "next",
      children,
      messages,
      scrollTop: 0,
      viewportY: 0,
      userOnly: true,
    }),
  ).toEqual({ id: "user-2", y: 40, top: 40 })
})

test("finds the previous user message without stopping at an assistant message", () => {
  expect(
    findMessageBoundary({
      direction: "prev",
      children: children.map((child) => ({ ...child, y: child.y - 35 })),
      messages,
      scrollTop: 35,
      viewportY: 0,
      userOnly: true,
    }),
  ).toEqual({ id: "user-1", y: 0, top: 0 })
})

test("preserves navigation across both user and assistant messages", () => {
  expect(
    findMessageBoundary({
      direction: "next",
      children,
      messages,
      scrollTop: 0,
      viewportY: 0,
    }),
  ).toEqual({ id: "assistant-1", y: 20, top: 19 })
  expect(
    findMessageBoundary({
      direction: "prev",
      children: children.map((child) => ({ ...child, y: child.y - 35 })),
      messages,
      scrollTop: 35,
      viewportY: 0,
    }),
  ).toEqual({ id: "assistant-1", y: 20, top: 19 })
})

test("uses the selected message when the viewport is too tall to scroll", () => {
  expect(
    findMessageBoundary({
      direction: "next",
      children,
      messages,
      scrollTop: 0,
      viewportY: 0,
      currentID: "user-1",
      userOnly: true,
    }),
  ).toEqual({ id: "user-2", y: 40, top: 40 })
  expect(
    findMessageBoundary({
      direction: "prev",
      children,
      messages,
      scrollTop: 0,
      viewportY: 0,
      currentID: "user-2",
      userOnly: true,
    }),
  ).toEqual({ id: "user-1", y: 0, top: 0 })
})

test("stops at the first and last selected user message", () => {
  expect(
    findMessageBoundary({
      direction: "next",
      children,
      messages,
      scrollTop: 0,
      viewportY: 0,
      currentID: "user-2",
      userOnly: true,
    }),
  ).toBeNull()
  expect(
    findMessageBoundary({
      direction: "prev",
      children,
      messages,
      scrollTop: 0,
      viewportY: 0,
      currentID: "user-1",
      userOnly: true,
    }),
  ).toBeNull()
})

test("keeps the logical boundary when layout temporarily moves it outside the viewport", () => {
  expect(
    findMessageBoundary({
      direction: "next",
      children,
      messages,
      scrollTop: 0,
      viewportY: 0,
      currentID: "user-2",
      userOnly: true,
    }),
  ).toBeNull()
})

test("stops at the first and last message", () => {
  expect(
    findMessageBoundary({
      direction: "next",
      children,
      messages,
      scrollTop: 0,
      viewportY: 0,
      currentID: "user-2",
    }),
  ).toBeNull()
  expect(
    findMessageBoundary({
      direction: "prev",
      children,
      messages,
      scrollTop: 0,
      viewportY: 0,
      currentID: "user-1",
    }),
  ).toBeNull()
})

function assistant(id: string, text: string): SessionMessageAssistant {
  return {
    type: "assistant",
    id,
    agent: "build",
    model: { providerID: "test", id: "test" },
    content: [{ type: "text", text }],
    time: { created: 1, completed: 1 },
  }
}

// Every input is pinned so the expected action is unambiguous under the rule order. `target` is
// always 0 where `boundary` is false: the helper must not read it on that path.
test("restore_retries_when_the_anchor_renderable_is_not_registered", () => {
  expect(
    scrollRestoreStep({
      target: 0,
      scrollTop: 1,
      scrollHeight: 22,
      viewportHeight: 21,
      currentSlack: 0,
      boundary: false,
      moreRows: false,
      attempts: 1,
      maxAttempts: 8,
    }),
  ).toEqual({ action: "retry" } satisfies ScrollRestoreStep)
})

test("restore_derives_slack_when_the_anchor_is_beyond_the_maximum", () => {
  expect(
    scrollRestoreStep({
      target: 13,
      scrollTop: 1,
      scrollHeight: 22,
      viewportHeight: 21,
      currentSlack: 0,
      boundary: true,
      moreRows: false,
      attempts: 3,
      maxAttempts: 8,
    }),
  ).toEqual({ action: "grow-slack", slack: 12 } satisfies ScrollRestoreStep)
})

test("restore_derives_slack_against_the_mounted_slack", () => {
  expect(
    scrollRestoreStep({
      target: 20,
      scrollTop: 13,
      scrollHeight: 34,
      viewportHeight: 21,
      currentSlack: 12,
      boundary: true,
      moreRows: false,
      attempts: 2,
      maxAttempts: 8,
    }),
  ).toEqual({ action: "grow-slack", slack: 19 } satisfies ScrollRestoreStep)
})

test("restore_grows_rows_before_slack", () => {
  expect(
    scrollRestoreStep({
      target: 13,
      scrollTop: 1,
      scrollHeight: 22,
      viewportHeight: 21,
      currentSlack: 0,
      boundary: true,
      moreRows: true,
      attempts: 2,
      maxAttempts: 8,
    }),
  ).toEqual({ action: "grow-rows" } satisfies ScrollRestoreStep)
})

test("restore_scrolls_when_the_target_is_reachable_but_not_applied", () => {
  expect(
    scrollRestoreStep({
      target: 9,
      scrollTop: 13,
      scrollHeight: 34,
      viewportHeight: 21,
      currentSlack: 12,
      boundary: true,
      moreRows: false,
      attempts: 4,
      maxAttempts: 8,
    }),
  ).toEqual({ action: "scroll", scrollTop: 9 } satisfies ScrollRestoreStep)
})

test("restore_settles_when_already_aligned", () => {
  expect(
    scrollRestoreStep({
      target: 13,
      scrollTop: 13,
      scrollHeight: 34,
      viewportHeight: 21,
      currentSlack: 12,
      boundary: true,
      moreRows: false,
      attempts: 4,
      maxAttempts: 8,
    }),
  ).toEqual({ action: "settle" } satisfies ScrollRestoreStep)
})

test("restore_gives_up_only_after_the_attempt_budget", () => {
  const at = (attempts: number) =>
    scrollRestoreStep({
      target: 0,
      scrollTop: 1,
      scrollHeight: 22,
      viewportHeight: 21,
      currentSlack: 0,
      boundary: false,
      moreRows: false,
      attempts,
      maxAttempts: 8,
    })
  expect(at(7)).toEqual({ action: "retry" } satisfies ScrollRestoreStep)
  expect(at(8)).toEqual({ action: "give-up" } satisfies ScrollRestoreStep)
})
