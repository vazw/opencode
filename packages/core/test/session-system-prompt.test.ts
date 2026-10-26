import { expect, test } from "bun:test"
import { SessionSystemPrompt } from "@opencode/core/session/system-prompt"

test("renders the default system prompt instructions", () => {
  const prompt = SessionSystemPrompt.make(["edit", "read", "shell"])
  expect(prompt).not.toContain("${OPENCODE_TOOL_GUIDANCE}")
  expect(prompt).toContain("Use the edit tool for targeted changes to existing text files")
})

function expectLiteralRender(tools: string[]) {
  // Double-quoted string on purpose: "${OPENCODE_TOOL_GUIDANCE}" is literal text here, not interpolation.
  const rendered = SessionSystemPrompt.render("<${OPENCODE_TOOL_GUIDANCE}>", tools)
  expect(rendered.split("<").length).toBe(2)
  expect(rendered.split(">").length).toBe(2)
  expect(rendered.startsWith("<")).toBe(true)
  expect(rendered.endsWith(">")).toBe(true)
  expect(rendered).not.toContain("${OPENCODE_TOOL_GUIDANCE}")
  expect(rendered).not.toContain("$")
}

test("renders todo guidance when the todowrite tool is advertised", () => {
  const tools = ["edit", "read", "shell", "todowrite"]
  const prompt = SessionSystemPrompt.make(tools)
  expect(prompt).not.toContain("${OPENCODE_TOOL_GUIDANCE}")
  expect(prompt).toContain("tool as your working plan")
  expect(prompt).toContain("3 or more distinct steps")
  expect(prompt).toContain("The user sees the list")
  expect(prompt).toContain("it replaces the previous list")
  expect(prompt).toContain("one item `in_progress` at a time")
  expect(prompt).toContain("as soon as it is done instead of batching")
  expect(prompt).toContain("in-session working state")
  expect(prompt).toContain("never cite")
  expect(prompt).toContain("re-derive facts from the files")
  expectLiteralRender(tools)
})

test("omits todo guidance when the todowrite tool is not advertised", () => {
  const tools = ["edit", "read", "shell"]
  const prompt = SessionSystemPrompt.make(tools)
  expect(prompt).not.toContain("todowrite")
  expect(prompt).not.toContain("working plan")
  expect(prompt).not.toContain("re-derive facts from the files")
  expectLiteralRender(tools)
})
