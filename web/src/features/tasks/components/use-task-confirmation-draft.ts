import { useState } from 'react'
import type { VideoTask } from '@/features/tasks/video-task.types'

const MIN_DURATION_SECONDS = 3
const MAX_DURATION_SECONDS = 50

export type TaskConfirmationDraft = {
  detectedDuration: boolean
  dirty: boolean
  durationError?: string
  durationInput: string
  durationManuallyEdited: boolean
  durationSeconds?: number
  ratio: string
  requirementDescription: string
  requirementEditing: boolean
  detectDuration: (duration: number) => void
  setDurationInput: (value: string) => void
  setRatio: (value: string) => void
  setRequirementDescription: (value: string) => void
  setRequirementEditing: (editing: boolean) => void
}

/**
 * 保存确认详情的单一草稿：上方规格、完整需求描述和下方素材编辑共同消费它。
 */
export const useTaskConfirmationDraft = (task: VideoTask): TaskConfirmationDraft => {
  const initialRequirementDescription = task.brief.requirementDescription ?? ''
  const [ratio, setRatio] = useState(task.brief.ratio ?? '')
  const [manualDurationInput, setManualDurationInput] = useState(() =>
    task.brief.durationSeconds === undefined ? '' : String(task.brief.durationSeconds),
  )
  const [durationManuallyEdited, setDurationManuallyEdited] = useState(false)
  const [detectedDurationSeconds, setDetectedDurationSeconds] = useState<number>()
  const [requirementDescription, setRequirementDescription] = useState(
    initialRequirementDescription,
  )
  const [requirementEditing, setRequirementEditing] = useState(false)

  const durationInput =
    task.brief.durationSeconds === undefined &&
    !durationManuallyEdited &&
    detectedDurationSeconds !== undefined
      ? String(detectedDurationSeconds)
      : manualDurationInput
  const durationSeconds = durationInput.trim() === '' ? undefined : Number(durationInput)
  const durationError =
    durationSeconds !== undefined &&
    (!Number.isInteger(durationSeconds) ||
      durationSeconds < MIN_DURATION_SECONDS ||
      durationSeconds > MAX_DURATION_SECONDS)
      ? '时长必须是 3–50 秒的整数'
      : undefined

  return {
    detectedDuration: detectedDurationSeconds !== undefined,
    dirty:
      ratio.trim() !== (task.brief.ratio ?? '') ||
      durationSeconds !== task.brief.durationSeconds ||
      requirementDescription.trim() !== initialRequirementDescription.trim(),
    durationError,
    durationInput,
    durationManuallyEdited,
    durationSeconds,
    ratio,
    requirementDescription: requirementDescription.trim(),
    requirementEditing,
    detectDuration: (duration) => {
      if (Number.isFinite(duration)) {
        setDetectedDurationSeconds(Math.round(duration))
      }
    },
    setDurationInput: (value) => {
      setDurationManuallyEdited(true)
      setManualDurationInput(value)
    },
    setRatio,
    setRequirementDescription,
    setRequirementEditing,
  }
}
