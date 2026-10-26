export * as SessionSystemPrompt from "./system-prompt.js"

import PROMPT from "./runner/prompt/system.txt"

export function make(tools: string[]) {
  return render(PROMPT, tools)
}

export function render(prompt: string, tools: string[]) {
  const instructions: string[] = []
  if (tools.includes("shell")) {
    instructions.push(
      "- Prefer dedicated tools over shell commands; fall back to the shell when a tool cannot do what you need.",
      "- Do not chain shell commands with separators like `echo \"====\";` or `printf '---'`; the output becomes noisy in a way that makes the user's side of the conversation worse.",
    )
  }
  if (tools.includes("write")) {
    instructions.push(
      "- Use the write tool to create files or completely replace their content. Prefer using the edit tool for targeted changes.",
    )
  }
  if (tools.includes("edit")) {
    instructions.push(
      "- Use the edit tool for targeted changes to existing text files. It replaces the exact text in `oldString` with `newString`, and the values must differ. By default, `oldString` must occur exactly once. If it occurs multiple times, include more surrounding context to make it unique or set `replaceAll` to true to replace every occurrence.",
    )
  }
  // Keyed on the advertised tool name, so the guidance disappears whenever todowrite is not in the snapshot.
  if (tools.includes("todowrite")) {
    instructions.push(
      "- Use the `todowrite` tool as your working plan when a task needs 3 or more distinct steps. The user sees the list, so keep it current instead of describing the plan only in prose.",
      "- Send the full list on every `todowrite` call; it replaces the previous list.",
      "- Keep one item `in_progress` at a time, and mark each item `completed` as soon as it is done instead of batching completions at the end.",
      "- Treat the list as in-session working state, not as durable record or evidence: never cite todo completion as proof. After compaction or a session reload, re-derive facts from the files.",
    )
  }
  return prompt.replace("${OPENCODE_TOOL_GUIDANCE}", instructions.join("\n"))
}
