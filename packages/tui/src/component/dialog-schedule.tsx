import { createResource, createSignal } from "solid-js"
import type { SessionScheduleInfo } from "@opencode/client"
import { type DialogContext, useDialog } from "../ui/dialog"
import { DialogSelect } from "../ui/dialog-select"
import { Keymap } from "../context/keymap"
import { useClient } from "../context/client"
import { useToast } from "../ui/toast"
import { useTheme } from "../context/theme"
import { errorMessage } from "../util/error"
import { formatDuration } from "../prompt/parse"

export function DialogSchedule(props: { sessionID: string }) {
  const dialog = useDialog()
  const client = useClient()
  const toast = useToast()
  const theme = useTheme().surface("dialog")
  const shortcuts = Keymap.useShortcuts()
  const [state, { refetch }] = createResource(async () => {
    try {
      return { schedules: await client.api.session.schedule.list({ sessionID: props.sessionID }), error: undefined }
    } catch (error) {
      return { schedules: [] as SessionScheduleInfo[], error }
    }
  })
  const [confirming, setConfirming] = createSignal<string>()

  const schedules = () => state()?.schedules ?? []
  const shortcut = () => shortcuts.get("schedule.cancel") ?? "ctrl+d"

  const cancel = (scheduleID: string) => {
    if (confirming() !== scheduleID) {
      setConfirming(scheduleID)
      return
    }
    setConfirming(undefined)
    const last = schedules().length === 1
    void client.api.session.schedule
      .cancel({ sessionID: props.sessionID, scheduleID })
      .then(() => {
        if (last) dialog.clear()
        else void refetch()
      })
      .catch((error) => {
        toast.show({
          message: `Failed to cancel scheduled prompt: ${errorMessage(error)}`,
          variant: "error",
          duration: 5000,
        })
      })
  }

  const empty = () => {
    if (state() === undefined && state.loading) return { message: "Loading scheduled prompts…", error: false }
    const failed = state()?.error
    if (failed) return { message: `Could not load scheduled prompts: ${errorMessage(failed)}`, error: true }
    return { message: "No scheduled prompts", error: false }
  }

  return (
    <DialogSelect
      title="Scheduled prompts"
      options={schedules().map((schedule, index) => {
        const armed = confirming() === schedule.id
        const remaining = schedule.deliverAt - Date.now()
        return {
          title: armed ? `Press ${shortcut()} again to cancel` : schedule.text,
          value: schedule.id,
          footer: `${index + 1} · ${remaining <= 0 ? "due" : `in ${formatDuration(remaining)}`}`,
          bg: armed ? theme.background.action.destructive.focused : undefined,
          fg: armed ? theme.text.action.destructive.focused : undefined,
        }
      })}
      onMove={() => setConfirming(undefined)}
      actions={[
        {
          command: "schedule.cancel",
          title: "cancel",
          onTrigger: (option) => cancel(option.value),
        },
      ]}
      emptyView={
        <box paddingLeft={4} paddingRight={4}>
          <text fg={empty().error ? theme.text.feedback.error.base : theme.text.muted}>{empty().message}</text>
        </box>
      }
      noMatchView={
        <box paddingLeft={4} paddingRight={4}>
          <text fg={theme.text.muted}>No matching scheduled prompts</text>
        </box>
      }
    />
  )
}

DialogSchedule.show = (dialog: DialogContext, sessionID: string) =>
  dialog.replace(() => <DialogSchedule sessionID={sessionID} />)
