export * as ShellCanonical from "./canonical.js"

const EMPTY: string[] = []
const WRAPPERS = new Set(["command", "exec", "env", "nohup", "time", "coproc", "!"])
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
// Whitespace, quotes, backtick, backslash, equals, redirections, pipes, separators,
// grouping and glob metacharacters: a head containing any of these is not a plain word.
const UNELIGIBLE = /[\s'"`\\=<>|&;()*?\[\]]/

// Wrappers are recognized by basename so /usr/bin/env, ~/bin/env, ./env and bin/time
// forward exactly like the bare words.
const isWrapper = (word: string) => WRAPPERS.has(word.slice(word.lastIndexOf("/") + 1))

const wordEnd = (resource: string, offset: number) => {
  const match = /\s/.exec(resource.slice(offset))
  return match ? offset + match.index : resource.length
}

const skipSpace = (resource: string, offset: number) => {
  let index = offset
  while (index < resource.length && /\s/.test(resource.charAt(index))) index++
  return index
}

// Alternate spellings of one invocation. Empty when the span is already canonical or
// the dialect is outside this batch's scope. Callers must not mutate the result.
export function variants(resource: string, powershell: boolean): string[] {
  // PowerShell is an explicit no-op: basenaming C:\bin\ssh.exe yields ssh.exe, which still
  // would not match `ssh *`, and extension normalization is a different rule.
  if (powershell) return EMPTY
  // Both scanners trim their span, so a leading space only fails open.
  if (resource === "" || /\s/.test(resource.charAt(0))) return EMPTY

  // Invariant: before each iteration `0 <= offset <= resource.length`; `resource.slice(0, offset)`
  // consists only of tokens that forward execution (a token whose basename is in WRAPPERS, or a
  // NAME=VALUE assignment) plus whitespace; `dropped` is true exactly when at least one such token
  // was consumed; `offset` points at the first character of the next token.
  //
  // Variant invariant: for a returned variant, `variant.slice(0, basename.length) === basename`,
  // `variant.slice(basename.length)` is byte-identical to `resource.slice(headEnd)`, and `basename`
  // is the last `/`-segment of the token the shell will execute. A rule whose pattern begins with
  // `<basename>` followed by a space (or end of string) therefore matches exactly the invocations
  // that run an executable named `<basename>`.
  //
  // Termination: each iteration either returns or strictly increases `offset` past at least one
  // whitespace character and at most `resource.length`, so the walk runs at most `resource.length`
  // times. It never re-enters a scanner, never chases a second command, never expands anything.
  // Unwrapping only ever shortens the variant and the next token must still pass the head
  // predicate, so basename-matching wrappers cannot over-reach beyond the existing deny rows.
  let offset = 0
  let dropped = false
  for (;;) {
    const end = wordEnd(resource, offset)
    const word = resource.slice(offset, end)
    if (word === "") return EMPTY
    // A wrapper option cannot be distinguished from a mode switch that prevents execution
    // (`command -v ssh` prints a path and runs nothing), so any dashy token aborts.
    if (word.startsWith("-")) return EMPTY
    if (isWrapper(word) || ASSIGNMENT.test(word)) {
      if (end >= resource.length) return EMPTY
      dropped = true
      offset = skipSpace(resource, end)
      if (offset >= resource.length) return EMPTY
      continue
    }

    const head = word
    const headEnd = end
    if (UNELIGIBLE.test(head)) return EMPTY
    const basename = head.slice(head.lastIndexOf("/") + 1)
    if (basename === "" || basename === "." || basename === "..") return EMPTY
    // A plain relative head with no dropped prefix is already canonical.
    if (!head.includes("/") && !dropped) return EMPTY
    const variant = basename + resource.slice(headEnd)
    return variant === resource ? EMPTY : [variant]
  }
}
