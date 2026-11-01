import { expect, test } from "bun:test"
import type { Config } from "../src/config"
import { createAppFixture } from "./fixture/app"
import { directory, json } from "./fixture/tui-client"
import { tmpdir } from "./fixture/fixture"

const TIMEOUT = 20_000

const ROOT = "ses_root"
const RUNNING = "ses_child_running"
const IDLE_CHILDREN = Array.from({ length: 25 }, (_, index) => `ses_child_${String(index).padStart(2, "0")}`)
const ALL = [ROOT, RUNNING, ...IDLE_CHILDREN]

function sessionInfo(id: string, idle?: number) {
  return {
    id,
    ...(id === ROOT ? {} : { parentID: ROOT }),
    title: id,
    projectID: "proj_test",
    location: { directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, updated: 0, ...(idle === undefined ? {} : { idle }) },
  }
}

const PERMISSION = { id: "per_test", sessionID: RUNNING, action: "shell", resources: ["bun test"] }

/** Records every per-session permission and form GET; everything else falls through to the fixture. */
function fetchFor(polls: Record<string, number>) {
  return (url: URL) => {
    if (url.pathname === "/api/session") {
      if (url.searchParams.get("parentID") !== ROOT) return json({ data: [], cursor: {} })
      // Newest first: the running child is candidate index 0, then the idle children.
      return json({ data: [sessionInfo(RUNNING), ...IDLE_CHILDREN.map((id) => sessionInfo(id, 1000))], cursor: {} })
    }
    if (url.pathname === "/api/session/active") return json({ data: { [RUNNING]: { type: "running" } } })
    const poll = /^\/api\/session\/([^/]+)\/(permission|form)$/.exec(url.pathname)
    if (poll) {
      const key = `${poll[1]}/${poll[2]}`
      polls[key] = (polls[key] ?? 0) + 1
      if (poll[1] === RUNNING && poll[2] === "permission") return json({ data: [PERMISSION] })
      return json({ data: [] })
    }
    const info = /^\/api\/session\/([^/]+)$/.exec(url.pathname)
    if (info && ALL.includes(info[1])) return json({ data: sessionInfo(info[1]) })
    const read = /^\/api\/session\/([^/]+)\/(message|inbox)$/.exec(url.pathname)
    if (read && ALL.includes(read[1])) return json({ data: [], cursor: {} })
    return undefined
  }
}

async function fixture(state: string, polls: Record<string, number>) {
  return createAppFixture({
    state,
    width: 100,
    height: 30,
    args: { sessionID: ROOT },
    config: { animations: false, tabs: { enabled: false } } satisfies Config.Info,
    fetch: fetchFor(polls),
  })
}

type Setup = Awaited<ReturnType<typeof fixture>>

function total(polls: Record<string, number>) {
  return Object.values(polls).reduce((sum, count) => sum + count, 0)
}

async function settled(setup: Setup, polls: Record<string, number>) {
  // The running child's request has to land before the budget is complete; the frame paints it.
  await setup.waitForFrame((frame) => frame.includes("Permission required"))
  await setup.waitForVisualIdle({ quietFrames: 2 })
  await setup.waitFor(() => total(polls) >= 12)
}

test(
  "idle subagents are never polled",
  async () => {
    await using state = await tmpdir()
    const polls: Record<string, number> = {}
    await using setup = await fixture(state.path, polls)
    await settled(setup, polls)

    // root + running child + the four newest idle children, two requests each.
    expect(total(polls)).toBeLessThanOrEqual(12)
    for (const id of IDLE_CHILDREN.slice(4)) {
      expect(polls[`${id}/permission`]).toBeUndefined()
      expect(polls[`${id}/form`]).toBeUndefined()
    }
  },
  TIMEOUT,
)

test(
  "running subagent permission surfaces",
  async () => {
    await using state = await tmpdir()
    const polls: Record<string, number> = {}
    await using setup = await fixture(state.path, polls)
    await settled(setup, polls)

    expect(polls[`${RUNNING}/permission`]).toBe(1)
    expect(setup.captureCharFrame()).toContain("Permission required")
  },
  TIMEOUT,
)
