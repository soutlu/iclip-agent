/** 草稿基于服务端版本保存。409 后重拉：不同组修改自动重放，同组冲突由用户选择；422 保留草稿并显示错误。 */

import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ApiError } from '@/shared/api/client'
import { readWorkspaceFile, workspaceQueryKeys, writeWorkspaceFile } from '@/shared/workbench'
import { validateShot } from './prompt-doc'
import { parseShotsDocument, type Shot, type ShotsDocument } from './shots'

const SAVE_DELAY_MS = 800

export type ShotConflict = { index: number; mine: Shot | undefined; theirs: Shot | undefined }

export type SaveState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved' }
  | { kind: 'error'; message: string }
  /** 同组冲突等待用户选择版本。 */
  | { kind: 'conflict'; shots: ShotConflict[] }

type Base = { version: number; document: ShotsDocument }

type UseShotsDraftOptions = {
  conversationId: string
  path: string
  file: { content: string; version: number } | undefined
}

const sameShot = (left: Shot | undefined, right: Shot | undefined) =>
  JSON.stringify(left ?? null) === JSON.stringify(right ?? null)

const shotOf = (document: ShotsDocument, index: number) =>
  document.shots.find((shot) => shot.index === index)

const replay = (latest: ShotsDocument, mine: ShotsDocument, dirty: Set<number>): ShotsDocument => ({
  ...latest,
  shots: latest.shots.map((shot) =>
    dirty.has(shot.index) ? (shotOf(mine, shot.index) ?? shot) : shot,
  ),
})

export const useShotsDraft = ({ conversationId, file, path }: UseShotsDraftOptions) => {
  const queryClient = useQueryClient()
  const parsed = useMemo(
    () => (file === undefined ? null : parseShotsDocument(file.content)),
    [file],
  )
  // 无本地草稿时直接显示服务端文档。
  const [edited, setEdited] = useState<ShotsDocument | null>(null)
  const [state, setState] = useState<SaveState>({ kind: 'idle' })
  // 异步保存通过 ref 读取最新草稿与版本，避免使用旧渲染快照。
  const ledgerRef = useRef({
    base: null as Base | null,
    dirty: new Set<number>(),
    edited: null as ShotsDocument | null,
    latest: null as Base | null,
    own: new Set<number>(),
    saving: false,
    timer: null as ReturnType<typeof setTimeout> | null,
  })

  const wroteVersion = useCallback((version: number) => ledgerRef.current.own.has(version), [])

  // 服务端更新只替换未修改的基线；未保存草稿交由版本冲突流程处理。
  useEffect(() => {
    const book = ledgerRef.current
    if (file === undefined || parsed === null || book.dirty.size > 0) return
    book.base = { document: parsed, version: file.version }
  }, [file, parsed])

  const document = edited ?? parsed

  const saveNow = useCallback(async () => {
    const book = ledgerRef.current
    if (book.timer !== null) {
      clearTimeout(book.timer)
      book.timer = null
    }
    const { base, edited: mine } = book
    if (base === null || mine === null || book.dirty.size === 0 || book.saving) return
    for (const index of book.dirty) {
      const shot = shotOf(mine, index)
      const problem = shot === undefined ? undefined : validateShot(shot)
      if (problem !== undefined) {
        setState({ kind: 'error', message: problem })
        return
      }
    }

    const write = async (toSave: ShotsDocument, expectedVersion: number) => {
      const saved = await writeWorkspaceFile(conversationId, {
        content: JSON.stringify(toSave, null, 2),
        expectedVersion,
        path,
      })
      book.base = { document: toSave, version: saved.file.version }
      book.own.add(saved.file.version)
      // 保存期间若仍有编辑，保留草稿和脏标记供下一次保存。
      if (book.edited === toSave) {
        book.dirty.clear()
        book.edited = null
        setEdited(null)
      }
      queryClient.setQueryData(workspaceQueryKeys.file(conversationId, path), saved)
      setState({ kind: 'saved' })
    }

    book.saving = true
    setState({ kind: 'saving' })
    try {
      await write(mine, base.version)
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 409) {
        setState({ kind: 'error', message: error instanceof Error ? error.message : '保存失败' })
        return
      }
      try {
        const latestFile = await queryClient.fetchQuery({
          queryFn: ({ signal }) => readWorkspaceFile(conversationId, path, signal),
          queryKey: workspaceQueryKeys.file(conversationId, path),
          staleTime: 0,
        })
        const latestDocument = parseShotsDocument(latestFile.file.content)
        if (latestDocument === null) {
          setState({ kind: 'error', message: '最新的文件读不出镜头组，先别存' })
          return
        }
        const latest: Base = { document: latestDocument, version: latestFile.file.version }
        const conflicts: ShotConflict[] = [...book.dirty]
          .filter(
            (index) => !sameShot(shotOf(latest.document, index), shotOf(base.document, index)),
          )
          .map((index) => ({
            index,
            mine: shotOf(mine, index),
            theirs: shotOf(latest.document, index),
          }))
        if (conflicts.length > 0) {
          book.latest = latest
          setState({ kind: 'conflict', shots: conflicts })
          return
        }
        const merged = replay(latest.document, mine, book.dirty)
        book.base = latest
        book.edited = merged
        setEdited(merged)
        await write(merged, latest.version)
      } catch (again) {
        setState({ kind: 'error', message: again instanceof Error ? again.message : '保存失败' })
      }
    } finally {
      book.saving = false
    }
  }, [conversationId, path, queryClient])

  const scheduleSave = useCallback(() => {
    const book = ledgerRef.current
    if (book.timer !== null) clearTimeout(book.timer)
    book.timer = setTimeout(() => void saveNow(), SAVE_DELAY_MS)
  }, [saveNow])

  const updateShot = useCallback(
    (next: Shot) => {
      const book = ledgerRef.current
      const current = book.edited ?? book.base?.document
      if (current === undefined) return
      const draft: ShotsDocument = {
        ...current,
        shots: current.shots.map((shot) => (shot.index === next.index ? next : shot)),
      }
      book.edited = draft
      book.dirty.add(next.index)
      setEdited(draft)
      setState({ kind: 'idle' })
      scheduleSave()
    },
    [scheduleSave],
  )

  /** 保留本地时重放到最新版；采用服务端时丢弃冲突组的本地修改。 */
  const resolveConflict = useCallback(
    (choice: 'mine' | 'theirs') => {
      const book = ledgerRef.current
      const latest = book.latest
      if (latest === null) return
      book.latest = null
      book.base = latest
      if (choice === 'theirs' || book.edited === null) {
        book.dirty.clear()
        book.edited = null
        setEdited(null)
        setState({ kind: 'idle' })
        return
      }
      const merged = replay(latest.document, book.edited, book.dirty)
      book.edited = merged
      setEdited(merged)
      setState({ kind: 'idle' })
      void saveNow()
    },
    [saveNow],
  )

  // 卸载前立即保存未提交的草稿。
  useEffect(() => {
    const book = ledgerRef.current
    return () => {
      if (book.timer !== null) {
        clearTimeout(book.timer)
        book.timer = null
        void saveNow()
      }
    }
  }, [saveNow])

  return { document, resolveConflict, state, updateShot, wroteVersion }
}
