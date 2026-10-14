export * as SessionSchedule from "./schedule.js"

import { and, asc, eq } from "drizzle-orm"
import { Context, DateTime, Effect, Layer } from "effect"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { ID, Info } from "@opencode/schema/session-schedule"
import { Database } from "../database/database.js"
import { Session } from "../session.js"
import { SessionMessage } from "./message.js"
import { SessionSchema } from "./schema.js"
import { SessionScheduleTable } from "./sql.js"

export { ID, Info }

/**
 * Durable delayed prompts. A row survives restarts, is delivered once, and stays visible and
 * cancellable until it fires. Each `add` arms an in-memory timer; `recover` re-arms every stored
 * row at boot, so a restart re-delivers whatever the previous process never fired.
 */
export const make = Effect.fn("SessionSchedule.make")(function* () {
  const database = yield* Database.Service
  const db = database.db
  const sessions = yield* Session.Service
  const scope = yield* Effect.scope

  const fromRow = (row: typeof SessionScheduleTable.$inferSelect): Info =>
    Info.make({
      id: ID.make(row.id),
      sessionID: SessionSchema.ID.make(row.session_id),
      text: row.text,
      deliverAt: DateTime.makeUnsafe(row.deliver_at),
      time: { created: DateTime.makeUnsafe(row.time_created) },
    })

  /**
   * Re-reads the row so a schedule cancelled after arming cannot deliver, and prompts under an id
   * derived from the row so a crash between admission and the delete cannot admit it twice:
   * `Session.prompt` reconciles that id against the already admitted item or message.
   */
  const deliver = Effect.fn("SessionSchedule.deliver")(function* (sessionID: SessionSchema.ID, id: ID) {
    const row = yield* db
      .select()
      .from(SessionScheduleTable)
      .where(and(eq(SessionScheduleTable.id, id), eq(SessionScheduleTable.session_id, sessionID)))
      .get()
      .pipe(Effect.orDie)
    if (row === undefined) return
    yield* sessions
      .prompt({ sessionID, id: SessionMessage.ID.make(`msg_${row.id}`), text: row.text, delivery: "steer" })
      .pipe(
        // The session is gone, so the schedule can never deliver; the delete below still runs.
        Effect.catchTag("Session.NotFoundError", (error) =>
          Effect.logWarning("dropped schedule for a missing session", { sessionID: error.sessionID, scheduleID: id }),
        ),
      )
    yield* db.delete(SessionScheduleTable).where(eq(SessionScheduleTable.id, id)).run().pipe(Effect.orDie)
  })

  const arm = (sessionID: SessionSchema.ID, id: ID, deliverAt: number) =>
    Effect.gen(function* () {
      yield* Effect.sleep(Math.max(0, deliverAt - Date.now()))
      // A failed prompt keeps the row: it stays listed and `recover` retries it at the next boot.
      yield* deliver(sessionID, id).pipe(
        Effect.catchCause((cause) => Effect.logError("scheduled prompt failed", { sessionID, scheduleID: id, cause })),
      )
    }).pipe(Effect.forkIn(scope))

  const add = Effect.fn("SessionSchedule.add")(function* (input: {
    readonly sessionID: SessionSchema.ID
    readonly text: string
    readonly delayMs: number
  }) {
    yield* sessions.get(input.sessionID)
    const id = ID.create()
    const now = Date.now()
    const deliverAt = now + input.delayMs
    yield* db
      .insert(SessionScheduleTable)
      .values({ id, session_id: input.sessionID, text: input.text, deliver_at: deliverAt, time_created: now })
      .run()
      .pipe(Effect.orDie)
    yield* arm(input.sessionID, id, deliverAt)
    return Info.make({
      id,
      sessionID: input.sessionID,
      text: input.text,
      deliverAt: DateTime.makeUnsafe(deliverAt),
      time: { created: DateTime.makeUnsafe(now) },
    })
  })

  const list = Effect.fn("SessionSchedule.list")(function* (sessionID: SessionSchema.ID) {
    yield* sessions.get(sessionID)
    const rows = yield* db
      .select()
      .from(SessionScheduleTable)
      .where(eq(SessionScheduleTable.session_id, sessionID))
      .orderBy(asc(SessionScheduleTable.deliver_at))
      .all()
      .pipe(Effect.orDie)
    return rows.map(fromRow)
  })

  const cancel = Effect.fn("SessionSchedule.cancel")(function* (input: {
    readonly sessionID: SessionSchema.ID
    readonly scheduleID: ID
  }) {
    yield* sessions.get(input.sessionID)
    yield* db
      .delete(SessionScheduleTable)
      .where(and(eq(SessionScheduleTable.id, input.scheduleID), eq(SessionScheduleTable.session_id, input.sessionID)))
      .run()
      .pipe(Effect.orDie)
  })

  /** Arms every stored row; an overdue one delivers on the next tick. Inert until called. */
  const recover = Effect.gen(function* () {
    const rows = yield* db
      .select()
      .from(SessionScheduleTable)
      .orderBy(asc(SessionScheduleTable.deliver_at))
      .all()
      .pipe(Effect.orDie)
    yield* Effect.forEach(rows, (row) => arm(SessionSchema.ID.make(row.session_id), ID.make(row.id), row.deliver_at), {
      discard: true,
    })
  })

  return { add, list, cancel, recover }
})

export type Interface = Effect.Success<ReturnType<typeof make>>

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionSchedule") {}

export const layer = Layer.effect(Service, make())

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node, Session.node] })
