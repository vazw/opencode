import { expect, spyOn, test } from "bun:test"
import { CliRenderEvents, type Renderable } from "@opentui/core"
import type { SessionMessageInfo } from "@opencode/client"
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
  dummy: "DummyView",
}

function sessionInfo(id: string, updated = 0) {
  return {
    id,
    title: TITLES[id],
    projectID: "proj_test",
    location: { directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, updated },
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

/** Serves the fixture sessions; every other request falls through to the shared defaults. */
function fetchFor(ids: string[]) {
  return (url: URL) => {
    if (url.pathname === "/api/session") {
      return json({ data: ids.map((id, index) => sessionInfo(id, index)), cursor: {} })
    }
    const match = /^\/api\/session\/([^/]+)(\/[a-z]+)?$/.exec(url.pathname)
    if (!match || !ids.includes(match[1])) return undefined
    const id = match[1]
    if (match[2] === undefined) return json({ data: sessionInfo(id) })
    if (match[2] === "/message") return json({ data: messages(id), cursor: {} })
    if (match[2] === "/inbox") return json({ data: [] })
    return undefined
  }
}

async function fixture(state: string, ids: string[], config?: Config.Info) {
  return createAppFixture({
    state,
    width: 100,
    height: 30,
    args: { sessionID: ids[0] },
    config: config ?? { animations: false, tabs: { enabled: false } },
    fetch: fetchFor(ids),
  })
}

type Setup = Awaited<ReturnType<typeof fixture>>

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

test(
  "keeps the session renderable mounted across switches instead of remounting it",
  async () => {
    await using state = await tmpdir()
    await using setup = await fixture(state.path, ["ses_alpha", "ses_beta"])
    await setup.waitForFrame((frame) => frame.includes("AlphaView answer"))
    await setup.waitForVisualIdle({ quietFrames: 2 })
    const cleanups = trackCleanups(setup)

    const alpha = activePane(setup)
    expect(panes(setup)).toHaveLength(1)

    const beta = await navigate(setup, "ses_beta")
    expect(beta).not.toBe(alpha)
    expect(panes(setup)).toHaveLength(2)

    const alphaAgain = await navigate(setup, "ses_alpha")

    expect(alphaAgain).toBe(alpha)
    expect(alpha.isDestroyed).toBe(false)
    expect(cleanups()).toBe(0)
    expect(panes(setup)).toHaveLength(2)
  },
  TIMEOUT,
)

test(
  "retains exactly the three most recent non-tab sessions and evicts the rest",
  async () => {
    await using state = await tmpdir()
    const ids = ["ses_1", "ses_2", "ses_3", "ses_4", "ses_5"]
    await using setup = await fixture(state.path, ids)
    await setup.waitForFrame((frame) => frame.includes("OneView answer"))
    await setup.waitForVisualIdle({ quietFrames: 2 })
    const cleanups = trackCleanups(setup)

    const retained = [activePane(setup)]
    for (const id of ids.slice(1)) retained.push(await navigate(setup, id))

    expect(panes(setup)).toHaveLength(3)
    expect(retained[0].isDestroyed).toBe(true)
    expect(retained[1].isDestroyed).toBe(true)
    expect(retained.slice(2).map((pane) => pane.isDestroyed)).toEqual([false, false, false])
    expect(cleanups()).toBe(2)
  },
  TIMEOUT,
)

test(
  "promotes a re-visited session so the least recently used one is evicted first",
  async () => {
    await using state = await tmpdir()
    const ids = ["ses_1", "ses_2", "ses_3", "ses_4"]
    await using setup = await fixture(state.path, ids)
    await setup.waitForFrame((frame) => frame.includes("OneView answer"))
    await setup.waitForVisualIdle({ quietFrames: 2 })
    const cleanups = trackCleanups(setup)

    const one = activePane(setup)
    const two = await navigate(setup, "ses_2")
    const three = await navigate(setup, "ses_3")

    const oneAgain = await navigate(setup, "ses_1")
    expect(oneAgain).toBe(one)

    const four = await navigate(setup, "ses_4")

    expect(panes(setup)).toHaveLength(3)
    expect(two.isDestroyed).toBe(true)
    expect([one, three, four].map((pane) => pane.isDestroyed)).toEqual([false, false, false])
    expect(cleanups()).toBe(1)
  },
  TIMEOUT,
)

test(
  "hides and detaches a background frame so the visible transcript keeps the full height",
  async () => {
    await using state = await tmpdir()
    await using setup = await fixture(state.path, ["ses_alpha", "ses_beta"])
    await setup.waitForFrame((frame) => frame.includes("AlphaView answer"))
    await setup.waitForVisualIdle({ quietFrames: 2 })

    const alpha = activePane(setup)
    // Height of a transcript that owns the whole session region.
    const fullHeight = alpha.height
    expect(fullHeight).toBeGreaterThan(0)

    const beta = await navigate(setup, "ses_beta")

    expect(panes(setup)).toHaveLength(2)
    expect(painted(alpha)).toBe(false)
    expect(painted(beta)).toBe(true)
    // A hidden frame left in the flex flow would split the region and halve this.
    expect(beta.height).toBe(fullHeight)
  },
  TIMEOUT,
)

test(
  "routes typed input to the re-activated session instead of a background frame",
  async () => {
    await using state = await tmpdir()
    await using setup = await fixture(state.path, ["ses_alpha", "ses_beta"])
    await setup.waitForFrame((frame) => frame.includes("AlphaView answer"))
    await setup.waitForVisualIdle({ quietFrames: 2 })

    await setup.mockInput.typeText("alpha-draft")
    await setup.waitForFrame((frame) => frame.includes("alpha-draft"))

    await navigate(setup, "ses_beta")
    await navigate(setup, "ses_alpha")

    await setup.mockInput.typeText("-more")
    await setup.waitForFrame((frame) => frame.includes("alpha-draft-more"))
  },
  TIMEOUT,
)

test(
  "unmounts a frame once its tab is closed",
  async () => {
    await using state = await tmpdir()
    await using setup = await fixture(state.path, ["ses_alpha", "ses_beta"], {
      animations: false,
      tabs: { enabled: true, scope: "global" },
    })
    await setup.waitForFrame((frame) => frame.includes("AlphaView answer"))
    await setup.waitForVisualIdle({ quietFrames: 2 })

    const alpha = activePane(setup)
    const beta = await navigate(setup, "ses_beta")
    expect(panes(setup)).toHaveLength(2)

    // Closing the current tab hands the route back to the previous one.
    setup.mockInput.pressKey("p", { ctrl: true })
    await setup.waitForFrame((frame) => frame.includes("Commands"))
    await setup.mockInput.typeText("Close tab")
    await setup.waitForFrame((frame) => frame.includes("Close tab"))
    setup.mockInput.pressEnter()
    await setup.waitForFrame((frame) => frame.includes("AlphaView answer"))
    // Tab state is persisted through a file lock, so the frame unmounts a write later.
    await setup.waitFor(() => panes(setup).length === 1)

    expect(beta.isDestroyed).toBe(true)
    expect(painted(alpha)).toBe(true)
  },
  TIMEOUT,
)
