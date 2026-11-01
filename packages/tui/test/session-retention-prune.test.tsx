import { expect, spyOn, test } from "bun:test"
import { CliRenderEvents, type Renderable } from "@opentui/core"
import type { SessionMessageInfo } from "@opencode/client"
import { mkdirSync } from "fs"
import path from "path"
import type { Config } from "../src/config"
import { createAppFixture } from "./fixture/app"
import { directory, json } from "./fixture/tui-client"
import { tmpdir } from "./fixture/fixture"

const TIMEOUT = 20_000

const TITLES: Record<string, string> = {
  ses_1: "OneView",
  ses_2: "TwoView",
  ses_3: "ThreeView",
  ses_4: "FourView",
  ses_5: "FiveView",
  ses_alpha: "AlphaView",
  ses_beta: "BetaView",
}

function sessionInfo(id: string) {
  return {
    id,
    title: TITLES[id],
    projectID: "proj_test",
    location: { directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, updated: 0 },
  }
}

function messages(id: string): SessionMessageInfo[] {
  return [
    { type: "user", id: `msg_user_${id}`, text: `${TITLES[id]} prompt`, time: { created: 0 } },
    {
      type: "assistant",
      id: `msg_assistant_${id}`,
      agent: "build",
      model: { providerID: "fixture", id: "fixture" },
      finish: "stop",
      time: { created: 1, completed: 2 },
      content: [{ type: "text", text: `${TITLES[id]} answer` }],
    },
  ]
}

/** Serves the fixture sessions and counts each transcript fetch per session ID. */
function fetchFor(ids: string[], transcriptLoads: Record<string, number>) {
  return (url: URL) => {
    if (url.pathname === "/api/session") {
      // `session.sync(id, { children: true })` asks for a parent's children; search asks without one.
      if (ids.includes(url.searchParams.get("parentID") ?? "")) return json({ data: [], cursor: {} })
      return json({ data: ids.map((id) => sessionInfo(id)), cursor: {} })
    }
    const match = /^\/api\/session\/([^/]+)(\/[a-z]+)?$/.exec(url.pathname)
    if (!match || !ids.includes(match[1])) return undefined
    const id = match[1]
    if (match[2] === undefined) return json({ data: sessionInfo(id) })
    if (match[2] === "/message") {
      transcriptLoads[id] = (transcriptLoads[id] ?? 0) + 1
      return json({ data: messages(id), cursor: {} })
    }
    if (match[2] === "/inbox") return json({ data: [] })
    return undefined
  }
}

type Fixture = { state: string; ids: string[]; tabs: string[]; transcriptLoads: Record<string, number> }

async function fixture(input: Fixture) {
  const file = path.join(input.state, "test", "tui", "tabs.json")
  mkdirSync(path.dirname(file), { recursive: true })
  await Bun.write(
    file,
    JSON.stringify({ global: { tabs: input.tabs.map((sessionID) => ({ sessionID })), unread: {} }, cwd: {} }),
  )
  return createAppFixture({
    state: input.state,
    width: 100,
    height: 30,
    args: { sessionID: input.ids[0] },
    config: { animations: false, tabs: { enabled: true, scope: "global" } } satisfies Config.Info,
    fetch: fetchFor(input.ids, input.transcriptLoads),
  })
}

type Setup = Awaited<ReturnType<typeof fixture>>

const five = ["ses_1", "ses_2", "ses_3", "ses_4", "ses_5"]
const pair = ["ses_alpha", "ses_beta"]

function walk(node: Renderable, visit: (node: Renderable) => void) {
  visit(node)
  for (const child of node.getChildren()) walk(child, visit)
}

/** Every mounted `SessionFrame` exposes exactly one `session-pane` renderable. */
function panes(setup: Setup) {
  const found: Renderable[] = []
  walk(setup.renderer.root, (node) => {
    if (node.id === "session-pane") found.push(node)
  })
  return found
}

function painted(node: Renderable) {
  for (let current: Renderable | null = node; current; current = current.parent) {
    if (!current.visible) return false
  }
  return true
}

/** The renderable of the session route on screen; background frames are hidden. */
function activePane(setup: Setup) {
  const visible = panes(setup).filter(painted)
  if (visible.length !== 1) throw new Error(`expected exactly one painted session pane, found ${visible.length}`)
  return visible[0]
}

/** Counts `SessionFrame` unmount cleanups: each frame removes its focus listener on teardown. */
function trackCleanups(setup: Setup) {
  const off = spyOn(setup.renderer, "off")
  return () => off.mock.calls.filter(([event]) => event === CliRenderEvents.FOCUSED_RENDERABLE).length
}

async function navigate(setup: Setup, id: string) {
  setup.mockInput.pressKey("o", { ctrl: true })
  await setup.waitForFrame((frame) => frame.includes("Search sessions"))
  await setup.mockInput.typeText(TITLES[id])
  await setup.waitForFrame((frame) => frame.includes(TITLES[id]))
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes(`${TITLES[id]} answer`))
  return activePane(setup)
}

async function boot(setup: Setup, id: string) {
  await setup.waitForFrame((frame) => frame.includes(`${TITLES[id]} answer`))
  await setup.waitForVisualIdle({ quietFrames: 2 })
}

/** The tab prefetch loads every persisted tab's transcript once; wait for it before counting. */
async function prefetched(setup: Setup, ids: readonly string[], loads: Record<string, number>) {
  await setup.waitFor(() => ids.every((id) => (loads[id] ?? 0) > 0))
  await setup.waitForVisualIdle({ quietFrames: 2 })
}

test(
  "frame budget is three with tabs",
  async () => {
    await using state = await tmpdir()
    const transcriptLoads: Record<string, number> = {}
    await using setup = await fixture({ state: state.path, ids: five, tabs: five, transcriptLoads })
    await boot(setup, "ses_1")

    // The budget fills as sessions are visited, so the first frame holds only the routed session.
    expect(panes(setup).length).toBeLessThanOrEqual(3)
    const first = activePane(setup)
    expect(painted(first)).toBe(true)

    await navigate(setup, "ses_2")
    await navigate(setup, "ses_3")
    expect(panes(setup).length).toBe(3)

    await navigate(setup, "ses_4")
    expect(panes(setup).length).toBe(3)
    expect(first.isDestroyed).toBe(true)
    expect(painted(activePane(setup))).toBe(true)
  },
  TIMEOUT,
)

test(
  "closed tab transcript is dropped",
  async () => {
    await using state = await tmpdir()
    const transcriptLoads: Record<string, number> = {}
    await using setup = await fixture({ state: state.path, ids: pair, tabs: pair, transcriptLoads })
    await boot(setup, "ses_alpha")
    await prefetched(setup, pair, transcriptLoads)

    await navigate(setup, "ses_beta")
    setup.mockInput.pressKey("p", { ctrl: true })
    await setup.waitForFrame((frame) => frame.includes("Commands"))
    await setup.mockInput.typeText("Close tab")
    await setup.waitForFrame((frame) => frame.includes("Close tab"))
    setup.mockInput.pressEnter()
    await setup.waitForFrame((frame) => frame.includes("AlphaView answer"))
    await setup.waitFor(() => panes(setup).length === 1)

    const before = transcriptLoads.ses_beta ?? 0
    await navigate(setup, "ses_beta")

    // A closed tab is not a tab, so its transcript must not survive it.
    expect(transcriptLoads.ses_beta ?? 0).toBeGreaterThan(before)
  },
  TIMEOUT,
)

test(
  "retained tab switch reuses renderable",
  async () => {
    await using state = await tmpdir()
    const transcriptLoads: Record<string, number> = {}
    await using setup = await fixture({ state: state.path, ids: ["ses_1", "ses_2"], tabs: ["ses_1", "ses_2"], transcriptLoads })
    await boot(setup, "ses_1")
    const cleanups = trackCleanups(setup)

    const first = activePane(setup)
    const second = await navigate(setup, "ses_2")
    expect(second).not.toBe(first)

    const back = await navigate(setup, "ses_1")
    expect(back).toBe(first)
    expect(first.isDestroyed).toBe(false)
    expect(cleanups()).toBe(0)
    expect(panes(setup).length).toBe(2)
  },
  TIMEOUT,
)

test(
  "recently viewed tab stays warm",
  async () => {
    await using state = await tmpdir()
    const transcriptLoads: Record<string, number> = {}
    await using setup = await fixture({ state: state.path, ids: five, tabs: five, transcriptLoads })
    await boot(setup, "ses_1")
    expect(panes(setup).length).toBeLessThanOrEqual(3)

    const start = activePane(setup)
    const first = await navigate(setup, "ses_5")
    const cleanups = trackCleanups(setup)
    await setup.waitForVisualIdle({ quietFrames: 2 })
    const loads = transcriptLoads.ses_5 ?? 0

    for (const [id, expected] of [
      ["ses_1", start],
      ["ses_5", first],
      ["ses_1", start],
      ["ses_5", first],
    ] as const) {
      expect(await navigate(setup, id)).toBe(expected)
    }
    // Tab-array position must not decide survival: the pair past the first slots stays mounted.
    expect(first.isDestroyed).toBe(false)
    expect(cleanups()).toBe(0)
    expect(transcriptLoads.ses_5 ?? 0).toBe(loads)
  },
  TIMEOUT,
)

test(
  "tab outside the budget cold mounts once",
  async () => {
    await using state = await tmpdir()
    const transcriptLoads: Record<string, number> = {}
    await using setup = await fixture({ state: state.path, ids: five, tabs: five, transcriptLoads })
    await boot(setup, "ses_1")
    expect(panes(setup).length).toBeLessThanOrEqual(3)

    const first = await navigate(setup, "ses_5")
    await setup.waitForVisualIdle({ quietFrames: 2 })
    const baseline = transcriptLoads.ses_5 ?? 0

    for (const id of ["ses_2", "ses_3", "ses_4"]) {
      await navigate(setup, id)
      expect(panes(setup).length).toBeLessThanOrEqual(3)
    }

    const second = await navigate(setup, "ses_5")
    expect(panes(setup).length).toBeLessThanOrEqual(3)
    expect(second).not.toBe(first)
    expect(first.isDestroyed).toBe(true)
    const returned = transcriptLoads.ses_5 ?? 0
    expect(returned - baseline).toBeLessThanOrEqual(2)

    const again = await navigate(setup, "ses_5")
    expect(again).toBe(second)
    expect(transcriptLoads.ses_5 ?? 0).toBe(returned)
  },
  TIMEOUT,
)
