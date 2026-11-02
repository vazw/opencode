import type { BunPlugin } from "bun"

// `@effect/platform-node-shared/dist/NodeWS.js` is only `export * from "ws"`, and `ws` is CJS.
// Bun 1.4.4 emits member accesses through a synthesized `exports_NodeWS` namespace that it never
// declares, so the first WebSocket upgrade in the compiled binary throws ReferenceError. Listing
// the members collapses the star re-export into plain named bindings.
// Names = the enumerable own keys of the bundled `ws@8.22.0` (`Object.keys(require("ws"))`),
// measured in the build image, minus `PerMessageDeflate`: ws@8.22.0 assigns that one dynamically
// (`WebSocket.PerMessageDeflate = …`), so Bun's CJS named-export detection does not see it and a
// named import fails the build. `export *` would have carried it, but nothing in the graph imports
// it. Keep the rest literal: `require("ws")` resolved from packages/cli is ws@8.21.0 (this
// package's own dependency), not the copy platform-node-shared bundles.
const WS_EXPORTS =
  'export { CONNECTING, OPEN, CLOSING, CLOSED, createWebSocketStream, extension, Receiver, Sender, Server, subprotocol, WebSocket, WebSocketServer } from "ws";'

const WS_STAR_REEXPORT = 'export * from "ws";'

export const wsStarReexportPlugin: BunPlugin = {
  name: "opencode-ws-star-reexport",
  setup(build) {
    build.onLoad({ filter: /[/\\]platform-node-shared[/\\]dist[/\\]NodeWS\.js$/ }, async (args) => {
      const text = await Bun.file(args.path).text()
      if (!text.includes(WS_STAR_REEXPORT)) {
        throw new Error(
          `ws star re-export rewrite missed: ${args.path} — @effect/platform-node-shared/NodeWS.js no longer contains \`${WS_STAR_REEXPORT}\`. Re-check whether the Bun CJS star-re-export workaround is still needed, then remove packages/cli/script/ws-reexport.ts or update it.`,
        )
      }
      return { contents: text.replaceAll(WS_STAR_REEXPORT, WS_EXPORTS), loader: "js" }
    })
  },
}
