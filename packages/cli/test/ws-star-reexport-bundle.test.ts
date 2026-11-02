import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import type { BunPlugin } from "bun"
import { wsStarReexportPlugin } from "../script/ws-reexport"

const entry = path.join(import.meta.dir, "fixture/ws-upgrade-entry.ts")

// `exports_<Name>` is the CJS interop namespace Bun synthesizes for `export * from "<cjs>"`.
// minify:false keeps that name legible; the shipped minified bundle carries the same dangling
// reference under a mangled name (`u_`, `w_`), which is why the assertion runs on a diagnostic
// bundle instead of on the artifact.
const interopUse = /\bexports_[A-Za-z0-9_$]+(?=\.)/g

function undeclaredInteropNamespaces(sources: string[]) {
  const text = sources.join("\n")
  const names = new Set(sources.flatMap((source) => [...source.matchAll(interopUse)].map((match) => match[0])))
  return [...names].filter((name) => !new RegExp(`\\b(?:var|let|const|function)\\s+${name}\\b|\\b${name}\\s*=`).test(text))
}

async function bundle(entrypoints: string[], plugins: BunPlugin[] = []) {
  const result = await Bun.build({
    entrypoints,
    target: "bun",
    format: "esm",
    minify: false,
    splitting: true,
    plugins,
  })
  if (!result.success) throw new Error(result.logs.map(String).join("\n"))
  return Promise.all(result.outputs.filter((output) => output.path.endsWith(".js")).map((output) => output.text()))
}

test("bundled websocket upgrade path has no undeclared interop namespace", async () => {
  const sources = await bundle([entry], [wsStarReexportPlugin])
  // Vacuity guard: if the fixture stops reaching the vulnerable module, the assertion below
  // would pass for the wrong reason.
  expect(sources.join("\n")).toContain("WebSocketServer")
  expect(undeclaredInteropNamespaces(sources)).toEqual([])
})

test("the interop check reports a dangling namespace use", () => {
  expect(undeclaredInteropNamespaces(["const wss = new exports_Foo.WebSocketServer({})"])).toEqual(["exports_Foo"])
  expect(undeclaredInteropNamespaces(["var exports_Foo = {}\nnew exports_Foo.WebSocketServer({})"])).toEqual([])
})

test("the rewrite fails loudly when the dependency shape changes", async () => {
  const dir = await mkdtemp(path.join(import.meta.dir, ".ws-drift-"))
  try {
    await Bun.write(path.join(dir, "platform-node-shared/dist/NodeWS.js"), "export const websocket = 1\n")
    await Bun.write(path.join(dir, "entry.ts"), 'export { websocket } from "./platform-node-shared/dist/NodeWS"\n')

    // Bun.build defaults to throw:true, so a plugin `throw` REJECTS the promise and the message
    // arrives via AggregateError.errors[].message. Capture the two outcomes explicitly: a missing
    // guard then reads as `Expected: true, Received: false` instead of a TypeError on undefined.
    const outcome = await Bun.build({
      entrypoints: [path.join(dir, "entry.ts")],
      target: "bun",
      format: "esm",
      minify: false,
      plugins: [wsStarReexportPlugin],
    }).then(
      () => ({ rejected: false, message: "" }),
      (error: any) => ({ rejected: true, message: (error?.errors ?? []).map((item: any) => item.message).join("\n") }),
    )

    expect(outcome.rejected).toBe(true)
    expect(outcome.message).toContain("ws star re-export rewrite missed")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
