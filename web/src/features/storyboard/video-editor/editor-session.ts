import { useState, useSyncExternalStore } from 'react'
import {
  applyEdit,
  createOriginalVersion,
  makeDemoVersions,
  type EditorVersion,
  type VideoEdit,
} from './editor-model'

import type { EditorReference } from './editor-composer'
export type EditorTask = {
  id: string
  version: EditorVersion
  edit: VideoEdit
  model: string
  references: readonly EditorReference[]
  stage: 'queued' | 'generating' | 'processing' | 'ready' | 'failed' | 'cancelled'
  createdAt: number
  adopted: boolean
}
export type EditorSession = {
  versions: readonly EditorVersion[]
  selectedId: string
  adoptedId: string
  tasks: readonly EditorTask[]
  prompt: string
  references: readonly EditorReference[]
  model: string
  selection: { start: number; end: number }
}
type SessionStore = {
  snapshot: EditorSession
  listeners: Set<() => void>
}
// UI 演示只在当前页面会话中保留；路由离开不清除任务，刷新不会冒充服务端恢复。
const stores = new Map<string, SessionStore>()
function getStore(id: string): SessionStore {
  const existing = stores.get(id)
  if (existing) return existing
  const demo = id === 'demo'
  const store: SessionStore = {
    snapshot: {
      versions: demo ? makeDemoVersions() : [],
      selectedId: demo ? 'v3' : 'original',
      adoptedId: 'original',
      tasks: [],
      prompt: demo ? '按参考图调整背景和光线，保留鞋款与运镜。' : '',
      references: [],
      model: '',
      selection: demo ? { start: 13, end: 15 } : { start: 0, end: 0 },
    },
    listeners: new Set(),
  }
  stores.set(id, store)
  return store
}
function update(store: SessionStore, patch: Partial<EditorSession>) {
  store.snapshot = { ...store.snapshot, ...patch }
  store.listeners.forEach((notify) => notify())
}
function changeTask(store: SessionStore, id: string, patch: Partial<EditorTask>) {
  update(store, {
    tasks: store.snapshot.tasks.map((task) => (task.id === id ? { ...task, ...patch } : task)),
  })
}

export function useEditorSession(id: string) {
  const [store] = useState(() => getStore(id))
  const session = useSyncExternalStore(
    (notify) => {
      store.listeners.add(notify)
      return () => {
        store.listeners.delete(notify)
      }
    },
    () => store.snapshot,
  )
  return {
    session,
    patch: (patch: Partial<EditorSession>) => update(store, patch),
    initialize: (duration: number) => {
      if (store.snapshot.versions.length || !Number.isFinite(duration) || duration <= 0) return
      update(store, {
        versions: [createOriginalVersion(duration)],
        selection: { start: 0, end: Math.min(4, duration) },
      })
    },
    submit: (parent: EditorVersion, kind: VideoEdit['kind'], extension: number) => {
      const state = store.snapshot
      const next =
        Math.max(
          1,
          ...state.versions.map((v) => Number(v.label.slice(1)) || 1),
          ...state.tasks.map((t) => Number(t.version.label.slice(1)) || 1),
        ) + 1
      const edit: VideoEdit = {
        id: crypto.randomUUID(),
        label: `V${next}`,
        kind,
        ...state.selection,
        extension,
        prompt: state.prompt.trim(),
      }
      const version = applyEdit(parent, edit)
      const task: EditorTask = {
        id: edit.id,
        version,
        edit,
        model: state.model,
        references: [...state.references],
        stage: 'queued',
        createdAt: Date.now(),
        adopted: false,
      }
      update(store, { tasks: [...state.tasks, task] })
      const transition = (stage: EditorTask['stage']) => {
        const current = store.snapshot.tasks.find((item) => item.id === task.id)
        if (
          !current ||
          current.stage === 'cancelled' ||
          current.stage === 'failed' ||
          current.stage === 'ready'
        )
          return
        if (stage === 'ready') update(store, { versions: [...store.snapshot.versions, version] })
        changeTask(store, task.id, { stage })
      }
      window.setTimeout(() => transition('generating'), 1200)
      window.setTimeout(
        () => transition(state.model === 'demo-failure' ? 'failed' : 'processing'),
        4200,
      )
      window.setTimeout(() => transition('ready'), 6500)
      return task.id
    },
    cancel: (taskId: string) => changeTask(store, taskId, { stage: 'cancelled' }),
    adopt: (versionId: string) => {
      update(store, {
        adoptedId: versionId,
        selectedId: versionId,
        tasks: store.snapshot.tasks.map((task) => ({
          ...task,
          adopted: task.version.id === versionId,
        })),
      })
    },
  }
}
