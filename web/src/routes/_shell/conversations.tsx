import { createFileRoute } from '@tanstack/react-router'
import { ConversationsRoute } from '@/features/conversations'
import { requireGovernor } from '../-require-governor'
import { useTaskPickerSource } from '../-use-task-picker-source'

export const Route = createFileRoute('/_shell/conversations')({
  beforeLoad: requireGovernor,
  component: ConversationsPage,
})

function ConversationsPage() {
  return <ConversationsRoute tasks={useTaskPickerSource()} />
}
