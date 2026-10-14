import { expect, test } from "bun:test"
import { createAppFixture } from "./fixture/app"
import { directory, json, type FetchHandler } from "./fixture/tui-client"

const location = { directory, project: { id: "project", directory, canonical: directory } }
const session = {
  id: "ses_schedule",
  title: "Scheduled session",
  projectID: "project",
  location: { directory },
  agent: "build",
  model: { providerID: "provider", id: "model" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 0, updated: 0 },
}

const pending = [
  { id: "sch_one", text: "Check the build", delayMs: 5_400_000 },
  { id: "sch_two", text: "Water the plants", delayMs: 45_000 },
]

function render(handleSchedule: FetchHandler) {
  return createAppFixture({
    args: { sessionID: session.id },
    config: { animations: false },
    fetch: async (url, request) => {
      if (url.pathname === "/api/location") return json(location)
      if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
      if (url.pathname === `/api/session/${session.id}`) return json({ data: session })
      if (url.pathname.startsWith(`/api/session/${session.id}/schedule`)) return handleSchedule(url, request)
      if (/^\/api\/session\/[^/]+\/(message|inbox|permission)$/.test(url.pathname))
        return json({ data: [], cursor: {} })
      if (url.pathname === "/api/agent")
        return json({ location, data: [{ id: "build", mode: "primary", hidden: false, permissions: [] }] })
      if (url.pathname === "/api/provider") return json({ location, data: [{ id: "provider", name: "Provider" }] })
      if (url.pathname === "/api/model")
        return json({ location, data: [{ id: "model", providerID: "provider", name: "Model", variants: [] }] })
      return undefined
    },
  })
}

function scheduleInfo(only?: readonly string[]) {
  return pending
    .filter((item) => !only || only.includes(item.id))
    .map((item) => ({
      id: item.id,
      sessionID: session.id,
      text: item.text,
      deliverAt: Date.now() + item.delayMs,
      time: { created: 0 },
    }))
}

test("/schedule durably schedules a prompt", async () => {
  const created: { text: string; delayMs: number }[] = []
  await using setup = await render(async (url, request) => {
    if (request.method !== "POST") return undefined
    const body = (await request.json()) as { text: string; delayMs: number }
    created.push(body)
    return json({ data: { ...scheduleInfo()[0]!, text: body.text } })
  })

  await setup.waitForFrame((frame) => frame.includes("Scheduled session"))
  await setup.mockInput.typeText("/schedule 1h30m Check the build")
  setup.mockInput.pressEnter()
  const frame = await setup.waitForFrame((value) => value.includes("Scheduled prompt in 1h 30m"))

  expect(created).toEqual([{ text: "Check the build", delayMs: 5_400_000 }])
  expect(frame).toContain("Scheduled session")
})

test("/schedule appears in the slash autocomplete list", async () => {
  await using setup = await render(async () => undefined)

  await setup.waitForFrame((frame) => frame.includes("Scheduled session"))
  await setup.mockInput.typeText("/sche")
  const frame = await setup.waitForFrame((value) => value.includes("/schedule") && value.includes("Schedule prompt"))

  expect(frame).toContain("/schedule")

  // Leave the composer empty: drafts are stashed per session across Prompt
  // remounts, so unsubmitted text would be restored into the next test's fixture.
  await setup.mockInput.pressEscape()
  setup.mockInput.pressKey("c", { ctrl: true })
  await setup.waitForFrame((value) => !value.includes("/sche"))
})

test("/schedule rejects a delay without a unit", async () => {
  let createCalls = 0
  await using setup = await render(async (url, request) => {
    if (request.method !== "POST") return undefined
    createCalls += 1
    return json({ data: scheduleInfo()[0]! })
  })

  await setup.waitForFrame((frame) => frame.includes("Scheduled session"))
  await setup.mockInput.typeText("/schedule 1h30")
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes('Invalid duration "1h30"'))

  expect(createCalls).toBe(0)
})

test("/schedule lists prompts and confirms cancellation", async () => {
  const cancelled: string[] = []
  await using setup = await render(async (url, request) => {
    if (request.method === "GET") return json({ data: scheduleInfo(cancelled.length ? ["sch_two"] : undefined) })
    if (request.method !== "DELETE") return undefined
    cancelled.push(url.pathname.slice(url.pathname.lastIndexOf("/") + 1))
    return new Response(null, { status: 204 })
  })

  await setup.waitForFrame((frame) => frame.includes("Scheduled session"))
  await setup.mockInput.typeText("/schedule ")
  setup.mockInput.pressEnter()
  const listed = await setup.waitForFrame(
    (frame) => frame.includes("Scheduled prompts") && frame.includes("Check the build"),
  )
  expect(listed).toContain("Water the plants")

  setup.mockInput.pressKey("d", { ctrl: true })
  const armed = await setup.waitForFrame((frame) => frame.includes("Press ctrl+d again to cancel"))
  expect(armed).toContain("Water the plants")
  expect(cancelled).toEqual([])

  setup.mockInput.pressKey("d", { ctrl: true })
  const remaining = await setup.waitForFrame(
    (frame) =>
      frame.includes("Water the plants") &&
      !frame.includes("Check the build") &&
      !frame.includes("Press ctrl+d again to cancel"),
  )
  expect(remaining).toContain("Scheduled prompts")
  expect(cancelled).toEqual(["sch_one"])
})

test("/schedule cancel cancels by list order", async () => {
  const cancelled: string[] = []
  await using setup = await render(async (url, request) => {
    if (request.method === "GET") return json({ data: scheduleInfo() })
    if (request.method !== "DELETE") return undefined
    cancelled.push(url.pathname.slice(url.pathname.lastIndexOf("/") + 1))
    return new Response(null, { status: 204 })
  })

  await setup.waitForFrame((frame) => frame.includes("Scheduled session"))
  await setup.mockInput.typeText("/schedule cancel 2")
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes("Cancelled scheduled prompt #2"))

  expect(cancelled).toEqual(["sch_two"])
})
