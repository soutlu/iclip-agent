import type { Task } from '../tasks.api'

type TaskInputs = Task['inputs']

export type TaskFormState = {
  title: string
  deadline: string
  inputs: TaskInputs
}

export const emptyTaskForm = (): TaskFormState => ({
  deadline: '',
  inputs: {
    creative_requirement: '',
    product: { image_oss_urls: [], name: '', style_no: '' },
    reference_image_oss_urls: { model: [], outfit: [], prop: [] },
    reference_video_oss_url: null,
    video_spec: {
      aspect_ratio: null,
      content_type: '',
      duration_seconds: null,
      platform: '',
      resolution: '',
      video_type: '',
    },
  },
  title: '',
})

export const taskFormOf = (task: Task): TaskFormState => ({
  deadline: task.deadline ? localDateTime(task.deadline) : '',
  inputs: task.inputs,
  title: task.title,
})

function localDateTime(iso: string): string {
  const date = new Date(iso)
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
  return local.toISOString().slice(0, 16)
}
