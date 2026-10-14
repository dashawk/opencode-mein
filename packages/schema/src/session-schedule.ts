export * as SessionSchedule from "./session-schedule.js"

import { Schema } from "effect"
import { ascending } from "./identifier.js"
import { DateTimeUtcFromMillis, statics } from "./schema.js"
import { SessionID } from "./session-id.js"

export const ID = Schema.String.check(Schema.isStartingWith("sch_")).pipe(
  Schema.brand("Session.Schedule.ID"),
  Schema.annotate({ identifier: "Session.Schedule.ID" }),
  statics((schema) => ({
    create: () => schema.make("sch_" + ascending()),
  })),
)
export type ID = typeof ID.Type

export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  id: ID,
  sessionID: SessionID,
  text: Schema.String,
  deliverAt: DateTimeUtcFromMillis,
  time: Schema.Struct({ created: DateTimeUtcFromMillis }),
}).annotate({ identifier: "Session.Schedule.Info" })
