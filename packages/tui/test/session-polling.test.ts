import { expect, test } from "bun:test"
import { pollableSessionIDs } from "../src/util/session-polling"

const idle = (sessionID: string) => ({ time: { idle: 1 } })
const children = (count: number) => Array.from({ length: count }, (_, index) => `ses_c${index}`)

test("drops idle children outside the tail", () => {
  const candidates = children(8)
  expect(
    pollableSessionIDs({
      include: ["ses_root"],
      candidates,
      running: [],
      pending: [],
      info: idle,
      limit: 2,
    }),
  ).toEqual(["ses_root", "ses_c0", "ses_c1"])
})

test("keeps every running child", () => {
  const candidates = children(8)
  const ids = pollableSessionIDs({
    include: ["ses_root"],
    candidates,
    running: candidates,
    pending: [],
    info: idle,
    limit: 2,
  })

  expect(ids).toEqual(["ses_root", ...candidates])
  expect(ids).toHaveLength(9)
})

test("keeps children holding a request", () => {
  const ids = pollableSessionIDs({
    include: ["ses_root"],
    candidates: children(14),
    running: [],
    pending: ["ses_c12"],
    info: idle,
    limit: 2,
  })

  expect(ids).toContain("ses_c12")
  // root + pending child + the two speculative slots; an unfiltered result would hold 15 IDs.
  expect(ids).toHaveLength(4)
})

test("bounds children with no info", () => {
  const ids = pollableSessionIDs({
    include: ["ses_root"],
    candidates: children(40),
    running: [],
    pending: [],
    info: () => undefined,
    limit: 5,
  })

  expect(ids).toContain("ses_root")
  expect(ids.length).toBeLessThanOrEqual(6)
})

test("dedupes include and candidates", () => {
  const ids = pollableSessionIDs({
    include: ["ses_root"],
    candidates: ["ses_root", "ses_c0"],
    running: [],
    pending: [],
    info: idle,
    limit: 2,
  })

  expect(ids).toEqual(["ses_root", "ses_c0"])
})

test("limit zero keeps only proven sessions", () => {
  const ids = pollableSessionIDs({
    include: ["ses_root"],
    candidates: children(4),
    running: [],
    pending: [],
    info: idle,
    limit: 0,
  })

  expect(ids).toEqual(["ses_root"])
})
