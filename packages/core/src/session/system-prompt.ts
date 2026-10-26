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
      "Task Management",
      "You have access to the `todowrite` tool to plan and track multi-step work. Use it whenever a task has three or more distinct steps, and keep it current so the user can see real progress.",
      "- Before starting a step, mark it in_progress (exactly one at a time).",
      "- As soon as a step is actually finished and verified, call todowrite again and mark it completed. Do this immediately, not at the end of the turn, and never batch several completions together.",
      "- Add newly discovered work as new todos; mark work that is no longer needed cancelled.",
      "- Do not end your turn while items you have finished are still shown as pending or in_progress.",
    )
  }
  return prompt.replace("${OPENCODE_TOOL_GUIDANCE}", instructions.join("\n"))
}
