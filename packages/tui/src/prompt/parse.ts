export function parseFileLineRange(input: string) {
  const hash = input.lastIndexOf("#")
  if (hash === -1) return { base: input }

  const base = input.slice(0, hash)
  const match = input.slice(hash + 1).match(/^(\d+)(?:-(\d*))?$/)
  if (!match) return { base }

  const startLine = Number(match[1])
  const endLine = match[2] && startLine < Number(match[2]) ? Number(match[2]) : undefined
  return { base, lineRange: { startLine, endLine } }
}

export function stripFileLineRange(input: string) {
  return parseFileLineRange(input).base
}

export function parseSlashHead(text: string, separator = /[ \t\n]/) {
  if (!text.startsWith("/")) return

  const end = text.slice(1).search(separator)
  if (end === -1) return { name: text.slice(1), arguments: "", end: text.length }

  const split = end + 1
  return { name: text.slice(1, split), arguments: text.slice(split + 1), end: split }
}

const delayPattern = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/

/** Parses a delay such as `1h30m` into milliseconds, or `undefined` when it is not a positive duration. */
export function parseDelay(input: string): number | undefined {
  const match = input.match(delayPattern)
  if (!match) return undefined
  const millis = ((Number(match[1] ?? 0) * 60 + Number(match[2] ?? 0)) * 60 + Number(match[3] ?? 0)) * 1000
  if (millis <= 0 || !Number.isSafeInteger(millis)) return undefined
  return millis
}

/** Formats milliseconds for display, such as `1h 30m` or `45s`. */
export function formatDuration(millis: number): string {
  const total = Math.max(0, Math.round(millis / 1000))
  if (total < 60) return `${total}s`
  const minutes = Math.floor(total / 60)
  if (minutes < 60) return total % 60 === 0 ? `${minutes}m` : `${minutes}m ${total % 60}s`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`
  const days = Math.floor(hours / 24)
  return hours % 24 === 0 ? `${days}d` : `${days}d ${hours % 24}h`
}

export type ScheduleCommand =
  | { readonly type: "list" }
  | { readonly type: "cancel"; readonly index: number }
  | { readonly type: "schedule"; readonly delayMs: number; readonly prompt: string }
  | { readonly type: "invalid"; readonly message: string }

const scheduleUsage = "Usage: /schedule <duration> <prompt>, /schedule list, /schedule cancel <n>"

/** Parses the arguments after `/schedule` into its list, cancel, or schedule form. */
export function parseSchedule(input: string): ScheduleCommand {
  const text = input.trim()
  if (text === "" || text === "list") return { type: "list" }

  const [head, ...rest] = text.split(/\s+/)
  if (head === "cancel") {
    const ordinal = rest[0]
    if (rest.length === 1 && ordinal !== undefined && /^\d+$/.test(ordinal)) {
      const index = Number(ordinal)
      if (Number.isSafeInteger(index) && index >= 1) return { type: "cancel", index }
    }
    return { type: "invalid", message: `Invalid schedule number "${ordinal ?? ""}". ${scheduleUsage}` }
  }

  const delayMs = parseDelay(head)
  if (delayMs === undefined) return { type: "invalid", message: `Invalid duration "${head}". ${scheduleUsage}` }
  const prompt = rest.join(" ")
  if (!prompt) return { type: "invalid", message: `Missing prompt after "${head}". ${scheduleUsage}` }
  return { type: "schedule", delayMs, prompt }
}
