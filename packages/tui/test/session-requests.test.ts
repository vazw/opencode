import { expect, test } from "bun:test"
import { createEffect, createRoot, createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import { createSessionRequests } from "../src/util/session-requests"

type Request = { sessionID: string; id: string }

function request(sessionID: string, id: string): Request {
  return { sessionID, id }
}

/**
 * Drives `createSessionRequests` against a reactive ID list and a per-session store, recording
 * every `list` invocation so the tests can prove per-child memoization instead of trusting it.
 */
function harness(initial: readonly string[]) {
  return createRoot((dispose) => {
    const [sessionIDs, setSessionIDs] = createSignal<readonly string[]>(initial)
    const [store, setStore] = createStore<Record<string, Request[] | undefined>>({})
    const calls = new Map<string, number>()
    const seen: Request[][] = []
    const requests = createSessionRequests(sessionIDs, (sessionID) => {
      calls.set(sessionID, (calls.get(sessionID) ?? 0) + 1)
      return store[sessionID]
    })
    createEffect(() => {
      seen.push(requests())
    })
    return {
      setSessionIDs,
      setRequests(sessionID: string, items: Request[]) {
        setStore(sessionID, items)
      },
      requestCount(sessionID: string) {
        return calls.get(sessionID) ?? 0
      },
      listCalls() {
        return Array.from(calls.values()).reduce((total, value) => total + value, 0)
      },
      output() {
        return seen.at(-1)!
      },
      dispose,
    }
  })
}

const ids = (requests: Request[]) => requests.map((item) => item.id)

test("returns an empty list when there are no session IDs", () => {
  const h = harness([])
  expect(h.output()).toEqual([])
  expect(h.listCalls()).toBe(0)
  h.dispose()
})

test("maps a single session's requests", () => {
  const h = harness(["ses_a"])
  h.setRequests("ses_a", [request("ses_a", "per_1"), request("ses_a", "per_2")])
  expect(ids(h.output())).toEqual(["per_1", "per_2"])
  expect(h.output().every((item) => item.sessionID === "ses_a")).toBe(true)
  h.dispose()
})

test("flattens requests across sessions in input order", () => {
  // Non-alphabetical order so a sort-based mutant cannot pass by accident.
  const h = harness(["ses_b", "ses_a"])
  h.setRequests("ses_b", [request("ses_b", "b1")])
  h.setRequests("ses_a", [request("ses_a", "a1"), request("ses_a", "a2")])
  expect(ids(h.output())).toEqual(["b1", "a1", "a2"])
  h.dispose()
})

test("adding a session ID only lists the newly added session", () => {
  const h = harness(["ses_a"])
  h.setRequests("ses_a", [request("ses_a", "a1")])
  const before = h.requestCount("ses_a")
  expect(before).toBeGreaterThan(0)

  h.setRequests("ses_b", [request("ses_b", "b1")])
  h.setSessionIDs(["ses_a", "ses_b"])

  // A plain flatMap over the ID list re-invokes list("ses_a") here; the memo must not.
  expect(h.requestCount("ses_a")).toBe(before)
  expect(h.requestCount("ses_b")).toBe(1)
  expect(ids(h.output())).toEqual(["a1", "b1"])
  h.dispose()
})

test("updating one session only re-evaluates that session", () => {
  const h = harness(["ses_a", "ses_b"])
  h.setRequests("ses_a", [request("ses_a", "a1")])
  h.setRequests("ses_b", [request("ses_b", "b1")])
  const before = h.requestCount("ses_a")

  h.setRequests("ses_b", [request("ses_b", "b2")])

  expect(h.requestCount("ses_a")).toBe(before)
  expect(ids(h.output())).toEqual(["a1", "b2"])
  h.dispose()
})

test("reordering non-collinear session IDs reuses every memo", () => {
  const h = harness(["ses_gamma", "ses_alpha", "ses_beta"])
  h.setRequests("ses_gamma", [request("ses_gamma", "g1")])
  h.setRequests("ses_alpha", [request("ses_alpha", "a1")])
  h.setRequests("ses_beta", [request("ses_beta", "b1")])
  const calls = h.listCalls()
  const perSession = ["ses_gamma", "ses_alpha", "ses_beta"].map((id) => h.requestCount(id))

  h.setSessionIDs(["ses_beta", "ses_gamma", "ses_alpha"])

  // Sorting or re-listing every child would either change the order or add calls.
  expect(h.listCalls()).toBe(calls)
  expect(["ses_gamma", "ses_alpha", "ses_beta"].map((id) => h.requestCount(id))).toEqual(perSession)
  expect(ids(h.output())).toEqual(["b1", "g1", "a1"])
  h.dispose()
})

test("duplicate session IDs keep one output entry each without corrupting memoization", () => {
  const h = harness(["ses_a", "ses_a"])
  h.setRequests("ses_a", [request("ses_a", "a1")])
  expect(ids(h.output())).toEqual(["a1", "a1"])
  const calls = h.requestCount("ses_a")

  h.setRequests("ses_b", [request("ses_b", "b1")])
  h.setSessionIDs(["ses_a", "ses_a", "ses_b"])

  expect(h.requestCount("ses_a")).toBe(calls)
  expect(ids(h.output())).toEqual(["a1", "a1", "b1"])
  h.dispose()
})

test("removing a session drops its requests and re-adding restores them", () => {
  const h = harness(["ses_a", "ses_b"])
  h.setRequests("ses_a", [request("ses_a", "a1")])
  h.setRequests("ses_b", [request("ses_b", "b1")])
  expect(ids(h.output())).toEqual(["a1", "b1"])

  h.setSessionIDs(["ses_a"])

  expect(ids(h.output())).toEqual(["a1"])

  h.setRequests("ses_b", [request("ses_b", "b2")])
  h.setSessionIDs(["ses_a", "ses_b"])

  expect(ids(h.output())).toEqual(["a1", "b2"])
  h.dispose()
})

test("treats an undefined list result as no requests", () => {
  const h = harness(["ses_unknown"])
  expect(h.output()).toEqual([])

  h.setRequests("ses_unknown", [request("ses_unknown", "per_1")])
  expect(ids(h.output())).toEqual(["per_1"])
  h.dispose()
})
