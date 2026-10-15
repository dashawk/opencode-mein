import { describe, expect } from "bun:test"
import type { FileSystem } from "@opencode/core/filesystem"
import { Effect, Layer, LayerMap } from "effect"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { Location } from "@opencode/schema/location"
import { Project } from "@opencode/core/project"
import { ProjectTable } from "@opencode/core/project/sql"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionInbox } from "@opencode/core/session/inbox"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionProjector } from "@opencode/core/session/projector"
import { SessionSchedule } from "@opencode/core/session/schedule"
import { SessionInboxTable, SessionScheduleTable, SessionTable } from "@opencode/core/session/sql"
import { SessionStore } from "@opencode/core/session/store"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import type { LocationServices } from "@opencode/core/location-services"
import { Image } from "@opencode/core/image"
import { Plugin } from "@opencode/core/plugin"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { Snapshot } from "@opencode/core/snapshot"
import { Skill } from "@opencode/core/skill"
import { advance, drain } from "./lib/clock"
import { testEffect } from "./lib/effect"

const wakeCalls: Session.ID[] = []
const execution = Layer.succeed(
  SessionExecution.Service,
  SessionExecution.Service.of({
    active: Effect.sync(() => new Set<Session.ID>()),
    isActive: () => Effect.succeed(false),
    resume: () => Effect.void,
    interrupt: () => Effect.succeed(false),
    wake: (sessionID) =>
      Effect.sync(() => {
        wakeCalls.push(sessionID)
      }),
    awaitIdle: () => Effect.void,
  }),
)
const locations = makeGlobalNode({
  service: LocationServiceMap.Service,
  layer: Layer.effect(
    LocationServiceMap.Service,
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      return yield* LayerMap.make(
        (_ref: Location.Ref) =>
          // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
          Layer.mergeAll(
            LayerNode.compile(LayerNode.group([PluginHooks.node, Skill.node]), {
              replacements: [Bus.node.replace(Layer.succeed(Bus.Service, bus))],
            }),
            Layer.mock(Image.Service, { normalize: (_resource, content) => Effect.succeed(content) }),
            Layer.mock(Snapshot.Service, { capture: () => Effect.undefined, restore: () => Effect.void }),
            Layer.mock(Plugin.Service, { awaitActivation: Effect.void }),
          ).pipe(Layer.fresh) as unknown as Layer.Layer<LocationServices, FileSystem.DirectoryNotFoundError>,
      )
    }),
  ),
  deps: [Bus.node],
})
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      Bus.node,
      SessionProjector.node,
      SessionStore.node,
      Session.node,
      SessionSchedule.node,
    ]),
    [
      Bus.node.replace(Bus.configured({ persist: true })),
      SessionExecution.node.replace(execution),
      LocationServiceMap.node.replace(locations),
    ],
  ),
)

const sessionID = Session.ID.make("ses_schedule_test")

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: Project.ID.global,
      slug: "test",
      directory: "/project",
      title: "test",
      version: "test",
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
})

/** The durable prompt a fired schedule admits, under the id derived from its row. */
const delivered = (id: SessionSchedule.ID) =>
  Database.Service.use(({ db }) => SessionInbox.find(db, SessionMessage.ID.make(`msg_${id}`)))
const inboxRows = () => Database.Service.use(({ db }) => db.select().from(SessionInboxTable).all().pipe(Effect.orDie))

/** Inserts a row the way a previous process would have left it, so no timer is armed for it. */
const leftover = (text: string, offsetMs: number) =>
  Database.Service.use(({ db }) =>
    Effect.gen(function* () {
      const id = SessionSchedule.ID.create()
      yield* db
        .insert(SessionScheduleTable)
        .values({
          id,
          session_id: sessionID,
          text,
          deliver_at: Date.now() + offsetMs,
          time_created: Date.now(),
        })
        .run()
        .pipe(Effect.orDie)
      return id
    }),
  )

describe("SessionSchedule", () => {
  it.effect("delivers the scheduled prompt once when its timer fires", () =>
    Effect.gen(function* () {
      yield* setup
      const schedule = yield* SessionSchedule.Service
      wakeCalls.length = 0

      const created = yield* schedule.add({ sessionID, text: "Check the build", delayMs: 1000 })

      expect(yield* schedule.list(sessionID)).toHaveLength(1)
      expect(wakeCalls).toEqual([])

      yield* advance(() => wakeCalls.length > 0)

      expect(wakeCalls).toEqual([sessionID])
      expect(yield* schedule.list(sessionID)).toEqual([])
      expect(yield* inboxRows()).toHaveLength(1)
      expect(yield* delivered(created.id)).toMatchObject({
        id: SessionMessage.ID.make(`msg_${created.id}`),
        sessionID,
        type: "user",
        delivery: "steer",
        payload: { text: "Check the build" },
      })
    }),
  )

  it.effect("keeps a schedule listed and cancellable until it fires", () =>
    Effect.gen(function* () {
      yield* setup
      const schedule = yield* SessionSchedule.Service
      wakeCalls.length = 0
      const created = yield* schedule.add({ sessionID, text: "Never", delayMs: 1000 })

      yield* schedule.cancel({ sessionID, scheduleID: created.id })
      // Cancelling a schedule that is already gone is a no-op.
      yield* schedule.cancel({ sessionID, scheduleID: created.id })

      expect(yield* schedule.list(sessionID)).toEqual([])

      yield* drain

      expect(wakeCalls).toEqual([])
      expect(yield* inboxRows()).toEqual([])
    }),
  )

  it.effect("re-arms rows left behind by a previous process at boot", () =>
    Effect.gen(function* () {
      yield* setup
      const schedule = yield* SessionSchedule.Service
      wakeCalls.length = 0
      const id = yield* leftover("After restart", 1000)

      yield* schedule.recover

      expect(yield* schedule.list(sessionID)).toHaveLength(1)
      expect(wakeCalls).toEqual([])

      yield* advance(() => wakeCalls.length > 0)

      expect(wakeCalls).toEqual([sessionID])
      expect(yield* schedule.list(sessionID)).toEqual([])
      expect(yield* delivered(id)).toMatchObject({ type: "user", payload: { text: "After restart" } })
    }),
  )

  it.effect("delivers an overdue row immediately on recovery", () =>
    Effect.gen(function* () {
      yield* setup
      const schedule = yield* SessionSchedule.Service
      wakeCalls.length = 0
      const id = yield* leftover("Overdue", -1000)

      yield* schedule.recover
      yield* advance(() => wakeCalls.length > 0)

      expect(wakeCalls).toEqual([sessionID])
      expect(yield* schedule.list(sessionID)).toEqual([])
      expect(yield* delivered(id)).toMatchObject({ type: "user", payload: { text: "Overdue" } })
    }),
  )

  it.effect("delivers exactly once when recovery races the armed timer", () =>
    Effect.gen(function* () {
      yield* setup
      const schedule = yield* SessionSchedule.Service
      wakeCalls.length = 0
      const created = yield* schedule.add({ sessionID, text: "Exactly once", delayMs: 1000 })

      yield* schedule.recover

      yield* advance(() => wakeCalls.length > 0)
      yield* drain

      expect(wakeCalls).toEqual([sessionID])
      expect(yield* inboxRows()).toHaveLength(1)
      expect(yield* delivered(created.id)).toMatchObject({ payload: { text: "Exactly once" } })
    }),
  )

  it.effect("refuses schedules for a session that does not exist", () =>
    Effect.gen(function* () {
      yield* setup
      const schedule = yield* SessionSchedule.Service
      const missing = Session.ID.make("ses_schedule_missing")

      expect(
        yield* schedule.add({ sessionID: missing, text: "Nowhere", delayMs: 1000 }).pipe(Effect.flip),
      ).toMatchObject({ _tag: "Session.NotFoundError" })
      expect(yield* schedule.list(missing).pipe(Effect.flip)).toMatchObject({ _tag: "Session.NotFoundError" })
      expect(yield* inboxRows()).toEqual([])
    }),
  )
})
