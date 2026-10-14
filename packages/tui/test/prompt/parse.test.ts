import { expect, test } from "bun:test"
import { formatDuration, parseDelay, parseFileLineRange, parseSchedule, parseSlashHead } from "../../src/prompt/parse"

test("preserves file line-range parsing semantics", () => {
  expect([
    parseFileLineRange("src/app.ts#12-20"),
    parseFileLineRange("src/app.ts#12-"),
    parseFileLineRange("src/app.ts#12-12"),
    parseFileLineRange("src/app.ts#bad"),
    parseFileLineRange("src/app.ts"),
  ]).toEqual([
    { base: "src/app.ts", lineRange: { startLine: 12, endLine: 20 } },
    { base: "src/app.ts", lineRange: { startLine: 12, endLine: undefined } },
    { base: "src/app.ts", lineRange: { startLine: 12, endLine: undefined } },
    { base: "src/app.ts" },
    { base: "src/app.ts" },
  ])
})

test("keeps frontend-specific slash separators", () => {
  expect(parseSlashHead("/editor\rfirst")).toEqual({ name: "editor\rfirst", arguments: "", end: 13 })
  expect(parseSlashHead("/editor\rfirst", /\s/)).toEqual({ name: "editor", arguments: "first", end: 7 })
  expect(parseSlashHead("editor")).toBeUndefined()
})

test("parses schedule delays with h/m/s units", () => {
  expect([
    parseDelay("1h"),
    parseDelay("30m"),
    parseDelay("1h30m"),
    parseDelay("45s"),
    parseDelay("2h45m10s"),
    parseDelay("90m"),
  ]).toEqual([3_600_000, 1_800_000, 5_400_000, 45_000, 9_910_000, 5_400_000])
})

test("rejects schedule delays that are not positive durations", () => {
  expect([parseDelay("0s"), parseDelay("1h30"), parseDelay("abc"), parseDelay("")]).toEqual([
    undefined,
    undefined,
    undefined,
    undefined,
  ])
})

test("dispatches schedule command forms", () => {
  expect(parseSchedule("")).toEqual({ type: "list" })
  expect(parseSchedule("list")).toEqual({ type: "list" })
  expect(parseSchedule("cancel 2")).toEqual({ type: "cancel", index: 2 })
  expect(parseSchedule("1h30m Check the build")).toEqual({
    type: "schedule",
    delayMs: 5_400_000,
    prompt: "Check the build",
  })
  expect(parseSchedule("1h30").type).toBe("invalid")
  expect(parseSchedule("5m").type).toBe("invalid")
  expect(parseSchedule("cancel").type).toBe("invalid")
  expect(parseSchedule("cancel 1.5").type).toBe("invalid")
})

test("formats durations for display", () => {
  expect([
    formatDuration(45_000),
    formatDuration(90_000),
    formatDuration(5_400_000),
    formatDuration(3_600_000),
    formatDuration(90_000_000),
  ]).toEqual(["45s", "1m 30s", "1h 30m", "1h", "1d 1h"])
})
