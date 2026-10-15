import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261014170155_session_schedule",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_schedule\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`text\` text NOT NULL,
          \`deliver_at\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_session_schedule_session_id_session_v2_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session_v2\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`session_schedule_session_deliver_at_idx\` ON \`session_schedule\` (\`session_id\`,\`deliver_at\`);`,
      )
    })
  },
}

export default migration
