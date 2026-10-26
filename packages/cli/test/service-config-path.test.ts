import { NodeFileSystem } from "@effect/platform-node"
import { Global } from "@opencode/util/global"
import { expect, test } from "bun:test"
import { Effect, FileSystem } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ServiceConfig } from "../src/services/service-config"

test("the service config directory sits beside the opencode config tree", () => {
  expect(ServiceConfig.configDirectory("/home/u/.config/opencode")).toBe("/home/u/.config/service")
  expect(ServiceConfig.configDirectory("/x/config/opencode")).toBe("/x/config/service")
  expect(
    path.join(ServiceConfig.configDirectory("/home/u/.config/opencode"), ServiceConfig.filename("dev")),
  ).toBe("/home/u/.config/service/service-dev.json")
  expect(
    path.join(ServiceConfig.configDirectory("/home/u/.config/opencode"), ServiceConfig.filename("latest")),
  ).toBe("/home/u/.config/service/service.json")
})

test("SERVICE_CONFIG_PATH names the config directory and replaces the derived one", () => {
  expect(ServiceConfig.configDirectory("/home/u/.config/opencode", "/srv/creds")).toBe("/srv/creds")
  expect(
    path.join(ServiceConfig.configDirectory("/home/u/.config/opencode", "/srv/creds"), ServiceConfig.filename("dev")),
  ).toBe("/srv/creds/service-dev.json")
})

test("SERVICE_CONFIG_PATH rejects a relative path and a file path", () => {
  expect(() => ServiceConfig.configDirectory("/x/opencode", "creds")).toThrow(/absolute/)
  expect(() => ServiceConfig.configDirectory("/x/opencode", "/srv/creds/service.json")).toThrow(/directory/)
})

test("service settings are written beside the config tree, not inside it", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-service-config-location-"))
  const layer = Global.layerWith({ config: path.join(root, "config", "opencode"), state: path.join(root, "state") })
  const run = <A, E>(effect: Effect.Effect<A, E, Global.Service | FileSystem.FileSystem>) =>
    Effect.runPromise(effect.pipe(Effect.provide(layer), Effect.provide(NodeFileSystem.layer)))
  try {
    await run(ServiceConfig.set("hostname", "127.0.0.2"))
    expect(await Bun.file(path.join(root, "config", "service", ServiceConfig.filename())).json()).toEqual({
      hostname: "127.0.0.2",
    })
    expect(await Bun.file(path.join(root, "config", "opencode", ServiceConfig.filename())).exists()).toBe(false)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("the relocated service config directory is private", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-service-config-mode-"))
  const layer = Global.layerWith({ config: path.join(root, "config", "opencode"), state: path.join(root, "state") })
  const run = <A, E>(effect: Effect.Effect<A, E, Global.Service | FileSystem.FileSystem>) =>
    Effect.runPromise(effect.pipe(Effect.provide(layer), Effect.provide(NodeFileSystem.layer)))
  try {
    await run(ServiceConfig.set("hostname", "127.0.0.2"))
    expect((await fs.stat(path.join(root, "config", "service"))).mode & 0o777).toBe(0o700)
    expect((await fs.stat(path.join(root, "config", "service", ServiceConfig.filename()))).mode & 0o777).toBe(0o600)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("the relocated config migrates the previous config file and keeps its password", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-service-config-migrate-"))
  const layer = Global.layerWith({ config: path.join(root, "config", "opencode"), state: path.join(root, "state") })
  const run = <A, E>(effect: Effect.Effect<A, E, Global.Service | FileSystem.FileSystem>) =>
    Effect.runPromise(effect.pipe(Effect.provide(layer), Effect.provide(NodeFileSystem.layer)))
  const previous = path.join(root, "config", "opencode", ServiceConfig.filename())
  try {
    await fs.mkdir(path.dirname(previous), { recursive: true })
    await fs.writeFile(previous, JSON.stringify({ password: "kept", port: 4001 }))
    expect(await run(ServiceConfig.read())).toEqual({ password: "kept", port: 4001 })
    expect(await Bun.file(path.join(root, "config", "service", ServiceConfig.filename())).json()).toEqual({
      password: "kept",
      port: 4001,
    })
    expect(await Bun.file(previous).json()).toEqual({ password: "kept", port: 4001 })
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("the relocated config prefers the current channel filename over the hashed legacy file", async () => {
  expect(
    ServiceConfig.legacyConfigFiles("/cfg/opencode", "service-preview-a.json", "service-abc.json"),
  ).toEqual(["/cfg/opencode/service-preview-a.json", "/cfg/opencode/service-abc.json"])
  expect(ServiceConfig.legacyConfigFiles("/cfg/opencode", "service-local.json", undefined)).toEqual([
    "/cfg/opencode/service-local.json",
  ])

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-service-config-precedence-"))
  try {
    const legacy = ServiceConfig.legacyConfigFiles(
      path.join(root, "opencode"),
      "service-preview-a.json",
      "service-abc.json",
    )
    await fs.mkdir(path.dirname(legacy[0]), { recursive: true })
    await fs.writeFile(legacy[0], JSON.stringify({ port: 4001 }))
    await fs.writeFile(legacy[1], JSON.stringify({ port: 4002 }))
    const target = path.join(root, "service", "service-preview-a.json")
    await Effect.runPromise(
      Effect.forEach(legacy, (file) => ServiceConfig.migrateConfig(file, target), { concurrency: 1 }).pipe(
        Effect.provide(NodeFileSystem.layer),
      ),
    )
    expect(await Bun.file(target).json()).toEqual({ port: 4001 })
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
