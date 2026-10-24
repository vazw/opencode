import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { ShellParse } from "@opencode/core/shell/parse"
import { ShellCanonical } from "../src/shell/canonical.js"
import { Wildcard } from "../src/util/wildcard.js"

type Row = {
  /** Raw span, which is also the scanner `resource`. */
  command: string
  /** Measured `save` on 181c5fe09f; must not move. */
  save: string
  variants: readonly string[]
  /** Additional commands the same span yields (nested substitutions). */
  nested?: ReadonlyArray<{ resource: string; save: string }>
}

// Measured on 181c5fe09f through both scanners; every literal here is a contract value.
const tableA: ReadonlyArray<Row> = [
  { command: "ssh -V", save: "ssh *", variants: [] },
  { command: "/usr/bin/ssh -V", save: "/usr/bin/ssh *", variants: ["ssh -V"] },
  { command: "~/bin/ssh -V", save: "~/bin/ssh *", variants: ["ssh -V"] },
  { command: "$HOME/bin/ssh -V", save: "$HOME/bin/ssh *", variants: ["ssh -V"] },
  { command: "./ssh -V", save: "./ssh *", variants: ["ssh -V"] },
  { command: "command ssh -V", save: "command *", variants: ["ssh -V"] },
  { command: "env ssh -V", save: "env *", variants: ["ssh -V"] },
  { command: "FOO=1 ssh -V", save: "ssh *", variants: ["ssh -V"] },
  { command: "nohup ssh -V", save: "nohup *", variants: ["ssh -V"] },
  { command: "time ssh -V", save: "time *", variants: ["ssh -V"] },
  { command: "exec ssh -V", save: "exec *", variants: ["ssh -V"] },
  { command: "coproc ssh -V", save: "coproc *", variants: ["ssh -V"] },
  { command: "FOO=1 /usr/bin/ssh -V", save: "/usr/bin/ssh *", variants: ["ssh -V"] },
  { command: "env FOO=1 /usr/bin/ssh -V", save: "env *", variants: ["ssh -V"] },
  { command: "/usr/bin/env ssh -V", save: "/usr/bin/env *", variants: ["ssh -V"] },
  { command: "~/bin/env ssh -V", save: "~/bin/env *", variants: ["ssh -V"] },
  { command: "$HOME/bin/env ssh -V", save: "$HOME/bin/env *", variants: ["ssh -V"] },
  { command: "./env ssh -V", save: "./env *", variants: ["ssh -V"] },
  { command: "/bin/time ssh -V", save: "/bin/time *", variants: ["ssh -V"] },
  { command: "/usr/bin/command ssh -V", save: "/usr/bin/command *", variants: ["ssh -V"] },
  { command: "/usr/bin/env ./ssh -V", save: "/usr/bin/env *", variants: ["ssh -V"] },
  { command: "FOO=1 /usr/bin/env /usr/bin/ssh -V", save: "/usr/bin/env *", variants: ["ssh -V"] },
  { command: "env FOO=1 /usr/bin/env ssh -V", save: "env *", variants: ["ssh -V"] },
  { command: "FOO=1 command env /usr/bin/ssh -V", save: "command *", variants: ["ssh -V"] },
  { command: "/usr/bin/ssh", save: "/usr/bin/ssh *", variants: ["ssh"] },
  { command: "/bin/rm -rf /", save: "/bin/rm *", variants: ["rm -rf /"] },
  { command: "/usr/bin/git push --force", save: "/usr/bin/git *", variants: ["git push --force"] },
]

const tableB: ReadonlyArray<Row> = [
  { command: "grep -r ssh .", save: "grep *", variants: [] },
  { command: "echo /usr/bin/ssh", save: "echo *", variants: [] },
  { command: "git log --grep /usr/bin/ssh", save: "git log *", variants: [] },
  { command: "/usr/bin/ssh-add -V", save: "/usr/bin/ssh-add *", variants: ["ssh-add -V"] },
  { command: "/usr/bin/ssh-keygen -t ed25519", save: "/usr/bin/ssh-keygen *", variants: ["ssh-keygen -t ed25519"] },
  { command: "command -v ssh", save: "command *", variants: [] },
  { command: "command -p ssh -V", save: "command *", variants: [] },
  { command: "env -i ssh -V", save: "env *", variants: [] },
  { command: "/usr/bin/env -i ssh -V", save: "/usr/bin/env *", variants: [] },
  { command: "./env -i ssh -V", save: "./env *", variants: [] },
  { command: "time -p ssh -V", save: "time *", variants: [] },
  { command: "/usr/bin/env", save: "/usr/bin/env *", variants: [] },
  { command: "bash -c 'ssh -V'", save: "bash *", variants: [] },
  {
    command: "$(printf 's%s' sh) -V",
    save: "$(printf 's%s' sh) *",
    variants: [],
    nested: [{ resource: "printf 's%s' sh", save: "printf *" }],
  },
  { command: ">/tmp/x ssh -V", save: "ssh *", variants: [] },
  { command: "'/usr/bin/ssh' -V", save: "'/usr/bin/ssh' *", variants: [] },
  { command: '"/usr/bin/ssh" -V', save: '"/usr/bin/ssh" *', variants: [] },
  { command: "\\ssh -V", save: "\\ssh *", variants: [] },
  { command: "/usr/bin/s*h -V", save: "/usr/bin/s*h *", variants: [] },
  { command: "'/usr/bin/env' ssh -V", save: "'/usr/bin/env' *", variants: [] },
  { command: "sudo -u root ssh -V", save: "sudo *", variants: [] },
  { command: "busybox ssh -V", save: "busybox *", variants: [] },
  { command: "/usr/bin/", save: "/usr/bin/ *", variants: [] },
  { command: "./..", save: "./.. *", variants: [] },
  { command: "command ssh\t-V", save: "command *", variants: ["ssh\t-V"] },
]

const rows = [...tableA, ...tableB]

// `variants` is omitted when empty, so an accidental `variants: []` fails the exact-shape assertions.
const expectedCommands = (row: Row) => [
  {
    resource: row.command,
    save: row.save,
    ...(row.variants.length > 0 ? { variants: [...row.variants] } : {}),
  },
  ...(row.nested ?? []),
]

const derive = (command: string) => ShellCanonical.variants(command, false)
const scan = (command: string, shell = "/bin/bash") =>
  Effect.runPromise(ShellParse.scan(command, shell, "/workspace"))
const scanPortable = (command: string, shell = "/bin/bash") =>
  Effect.runPromise(ShellParse.scanPortable(command, shell, "/workspace"))
const scanExplicit = (command: string, shell = "/bin/bash") =>
  Effect.runPromise(ShellParse.scan(command, shell, "/workspace", { portable: true }))

describe("ShellCanonical.variants", () => {
  test("returns no variant for plain relative commands", () => {
    const empty = derive("")
    expect(empty).toEqual([])
    for (const command of [
      "ssh -V",
      "grep -r ssh .",
      "echo /usr/bin/ssh",
      "git log --grep /usr/bin/ssh",
      "bash -c 'ssh -V'",
      "sudo -u root ssh -V",
      "busybox ssh -V",
    ]) {
      expect(derive(command), command).toBe(empty)
    }
  })

  test("returns no variant for PowerShell", () => {
    expect(ShellCanonical.variants("ssh -V", true)).toEqual([])
    expect(ShellCanonical.variants("/usr/bin/ssh -V", true)).toEqual([])
    expect(ShellCanonical.variants("env ssh -V", true)).toEqual([])
    expect(ShellCanonical.variants("/usr/bin/env ./ssh -V", true)).toEqual([])
  })

  test("derives one variant for path-qualified heads", () => {
    expect(derive("/usr/bin/ssh -V")).toEqual(["ssh -V"])
    expect(derive("~/bin/ssh -V")).toEqual(["ssh -V"])
    expect(derive("$HOME/bin/ssh -V")).toEqual(["ssh -V"])
    expect(derive("./ssh -V")).toEqual(["ssh -V"])
    expect(derive("/usr/bin/ssh")).toEqual(["ssh"])
    expect(derive("/bin/rm -rf /")).toEqual(["rm -rf /"])
    expect(derive("/usr/bin/git push --force")).toEqual(["git push --force"])
  })

  test("derives one variant by dropping wrapper prefixes", () => {
    for (const command of [
      "command ssh -V",
      "env ssh -V",
      "nohup ssh -V",
      "time ssh -V",
      "exec ssh -V",
      "coproc ssh -V",
      "! ssh -V",
    ]) {
      expect(derive(command), command).toEqual(["ssh -V"])
    }
  })

  test("derives one variant by unwrapping path-qualified wrapper heads", () => {
    expect(derive("/usr/bin/env ssh -V")).toEqual(["ssh -V"])
    expect(derive("~/bin/env ssh -V")).toEqual(["ssh -V"])
    expect(derive("$HOME/bin/env ssh -V")).toEqual(["ssh -V"])
    expect(derive("./env ssh -V")).toEqual(["ssh -V"])
    expect(derive("/bin/time ssh -V")).toEqual(["ssh -V"])
    expect(derive("/usr/bin/command ssh -V")).toEqual(["ssh -V"])
    expect(derive("/usr/bin/env ./ssh -V")).toEqual(["ssh -V"])
    // A wrapper is recognized by basename, so two wrapper prefixes unwrap in sequence.
    expect(derive("env env ssh -V")).toEqual(["ssh -V"])
  })

  test("derives one variant by dropping assignment prefixes", () => {
    expect(derive("FOO=1 ssh -V")).toEqual(["ssh -V"])
    expect(derive("_FOO9=1 ssh -V")).toEqual(["ssh -V"])
    expect(derive("FOO=1 /usr/bin/ssh -V")).toEqual(["ssh -V"])
    expect(derive("env FOO=1 /usr/bin/ssh -V")).toEqual(["ssh -V"])
    expect(derive("env FOO=1 /usr/bin/env ssh -V")).toEqual(["ssh -V"])
  })

  test("walks a bounded mixed prefix chain", () => {
    expect(derive("FOO=1 /usr/bin/env /usr/bin/ssh -V")).toEqual(["ssh -V"])
    expect(derive("FOO=1 command env /usr/bin/ssh -V")).toEqual(["ssh -V"])
    expect(derive("A=1 B=2 nohup time ./bin/sh -c true")).toEqual(["sh -c true"])
  })

  test("returns no variant for wrapper options and dashy heads", () => {
    for (const command of [
      "command -v ssh",
      "command -p ssh -V",
      "env -i ssh -V",
      "/usr/bin/env -i ssh -V",
      "./env -i ssh -V",
      "time -p ssh -V",
      "-x ssh",
    ]) {
      expect(derive(command), command).toEqual([])
    }
  })

  test("returns no variant for quoted, escaped, globbed and substituted heads", () => {
    for (const command of [
      "'/usr/bin/ssh' -V",
      '"/usr/bin/ssh" -V',
      "\\ssh -V",
      "/usr/bin/s*h -V",
      "'/usr/bin/env' ssh -V",
      "$(printf 's%s' sh) -V",
    ]) {
      expect(derive(command), command).toEqual([])
    }
  })

  test("returns no variant for redirect-prefixed spans", () => {
    expect(derive(">/tmp/x ssh -V")).toEqual([])
    expect(derive("ssh -V >/tmp/x")).toEqual([])
  })

  test("returns no variant for empty, dot and dot-dot basenames", () => {
    expect(derive("/usr/bin/")).toEqual([])
    expect(derive("./..")).toEqual([])
    expect(derive("/usr/bin/.")).toEqual([])
    expect(derive("   ")).toEqual([])
    expect(derive(" ssh -V")).toEqual([])
    expect(derive("env")).toEqual([])
    expect(derive("/usr/bin/env")).toEqual([])
    expect(derive("FOO=1")).toEqual([])
    expect(derive("env   ")).toEqual([])
  })

  test("keeps sibling command names out of a denied prefix", () => {
    expect(derive("/usr/bin/ssh-add -V")).toEqual(["ssh-add -V"])
    expect(derive("/usr/bin/ssh-keygen -t ed25519")).toEqual(["ssh-keygen -t ed25519"])
    expect(Wildcard.match(derive("/usr/bin/ssh-add -V")[0]!, "ssh *")).toBe(false)
    expect(Wildcard.match(derive("/usr/bin/ssh-keygen -t ed25519")[0]!, "ssh *")).toBe(false)
    expect(Wildcard.match(derive("/usr/bin/ssh -V")[0]!, "ssh *")).toBe(true)
  })

  test("keeps the remainder verbatim including tabs", () => {
    expect(derive("command ssh\t-V")).toEqual(["ssh\t-V"])
    expect(derive("/usr/bin/ssh -V  --flag   x")).toEqual(["ssh -V  --flag   x"])
    expect(derive("/usr/bin/ssh 'a  b' > out")).toEqual(["ssh 'a  b' > out"])
    expect(derive("/usr/bin/env /usr/bin/ssh <<'EOF'\nbody\nEOF")).toEqual(["ssh <<'EOF'\nbody\nEOF"])
  })

  test("matches every measured table row", () => {
    for (const { command, variants } of rows) {
      expect(derive(command), command).toEqual([...variants])
      expect(variants.length, command).toBeLessThanOrEqual(1)
      if (variants.length === 1) expect(variants[0], command).not.toBe(command)
    }
  })
})

describe("ShellCanonical scanner integration", () => {
  test("emits identical variants, resources and saves across legacy and portable scanners", async () => {
    for (const row of rows) {
      const expected = expectedCommands(row)
      const legacy = await scan(row.command)
      const portable = await scanPortable(row.command)
      const explicit = await scanExplicit(row.command)
      expect(legacy.commands, row.command).toEqual(expected)
      expect(portable.commands, row.command).toEqual(expected)
      expect(explicit.commands, row.command).toEqual(expected)
      expect(legacy.directories, row.command).toEqual([])
      expect(portable.directories, row.command).toEqual([])
    }
  })

  test("keeps save derived from the raw head for every escape form", async () => {
    for (const row of rows) {
      const saves = [row.save, ...(row.nested ?? []).map((nested) => nested.save)]
      expect((await scan(row.command)).commands.map((command) => command.save), row.command).toEqual(saves)
      expect((await scanPortable(row.command)).commands.map((command) => command.save), row.command).toEqual(saves)
    }
  })

  test("keeps variants singular, scanner-independent and distinct from the raw span", async () => {
    for (const row of rows) {
      const legacy = await scan(row.command)
      const portable = await scanPortable(row.command)
      const explicit = await scanExplicit(row.command)
      const collected = [legacy, portable, explicit].map((result) =>
        result.commands.flatMap((command) => command.variants ?? []),
      )
      expect(collected[1], row.command).toEqual(collected[0])
      expect(collected[2], row.command).toEqual(collected[0])
      for (const result of [legacy, portable, explicit])
        for (const command of result.commands) {
          expect(command.variants?.length ?? 0, row.command).toBeLessThanOrEqual(1)
          for (const variant of command.variants ?? []) expect(variant, row.command).not.toBe(command.resource)
        }
    }
  })

  test("reports no variants for PowerShell commands", async () => {
    for (const command of ["ssh -V", "env ssh -V"]) {
      for (const result of [await scan(command, "pwsh"), await scanPortable(command, "pwsh")]) {
        expect(result.commands.length, command).toBeGreaterThan(0)
        for (const item of result.commands) expect(item.variants, command).toBeUndefined()
      }
    }
  })
})
