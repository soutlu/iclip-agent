/**
 * `video_shot.json` 的草稿与保存：改了就存，带版本号，撞车了先看撞的是不是同一组。
 *
 * 服务端那份文件是事实源，这里只持有一份「基于第 N 版改出来的草稿」。用户每改一下（描述、秒数、
 * 帧）先落进草稿、记下改的是哪一组，停手片刻后整份 PUT 回去：
 *
 * - 成功：草稿成为新的基线，版本号跟着服务端。
 * - 409（版本对不上）：重拉最新。用户改过的那几组在最新版里如果与基线一样，说明别人改的是别的组，
 *   把我的改动重放到最新版上再存一次；只要有一组两边都改了，停下来让用户选。
 * - 422（形状不合规）：保存不下去，原文照实显示，草稿留着让用户改。
 *
 * 不静默覆盖：任何一条路都不会拿旧内容盖掉别人写的新内容。
 */

import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ApiError } from '@/shared/api/client'
import { readWorkspaceFile, workspaceQueryKeys, writeWorkspaceFile } from '@/shared/workbench'
import { validateShot } from './prompt-doc'
import { parseShotsDocument, type Shot, type ShotsDocument } from './shots'

/** 停手多久之后写回。 */
const SAVE_DELAY_MS = 800

export type ShotConflict = { index: number; mine: Shot | undefined; theirs: Shot | undefined }

export type SaveState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved' }
  | { kind: 'error'; message: string }
  /** 两边都改了同一组：等用户选留哪份。 */
  | { kind: 'conflict'; shots: ShotConflict[] }

type Base = { version: number; document: ShotsDocument }

type UseShotsDraftOptions = {
  conversationId: string
  path: string
  /** 服务端那份文件；还没读到时是 undefined。 */
  file: { content: string; version: number } | undefined
}

const sameShot = (left: Shot | undefined, right: Shot | undefined) =>
  JSON.stringify(left ?? null) === JSON.stringify(right ?? null)

const shotOf = (document: ShotsDocument, index: number) =>
  document.shots.find((shot) => shot.index === index)

/** 把我改过的那几组放到别人的最新版上。 */
const replay = (latest: ShotsDocument, mine: ShotsDocument, dirty: Set<number>): ShotsDocument => ({
  ...latest,
  shots: latest.shots.map((shot) =>
    dirty.has(shot.index) ? (shotOf(mine, shot.index) ?? shot) : shot,
  ),
})

/**
 * 管一份镜头组 prompt 表的草稿。
 *
 * @param options - 哪段对话的哪个文件，以及服务端那份的当前内容。
 * @returns 当前该显示的文档、改一组的方法、保存状态与冲突的处置。
 */
export const useShotsDraft = ({ conversationId, file, path }: UseShotsDraftOptions) => {
  const queryClient = useQueryClient()
  const parsed = useMemo(
    () => (file === undefined ? null : parseShotsDocument(file.content)),
    [file],
  )
  // 用户改出来的那份；没改过就是 null，界面直接显示服务端那份
  const [edited, setEdited] = useState<ShotsDocument | null>(null)
  const [state, setState] = useState<SaveState>({ kind: 'idle' })
  // 保存这条路上的账本都在 ref 里：写回是异步的，读的必须是此刻的值而不是某次渲染的快照
  const ledgerRef = useRef({
    base: null as Base | null,
    dirty: new Set<number>(),
    edited: null as ShotsDocument | null,
    latest: null as Base | null,
    // 自己写出去的那些版本号：文件版本变了但在这里面，就不是别人改的
    own: new Set<number>(),
    saving: false,
    timer: null as ReturnType<typeof setTimeout> | null,
  })

  /** 这个版本是不是自己写出去的。界面据此决定要不要标「agent 刚改过」。 */
  const wroteVersion = useCallback((version: number) => ledgerRef.current.own.has(version), [])

  // 服务端那份变了：手上没有未存的改动就以它为基线；有的话留给保存那一步去撞版本号，不在这里丢改动
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
        // 落文件的写法与工具一致：两格缩进
        content: JSON.stringify(toSave, null, 2),
        expectedVersion,
        path,
      })
      book.base = { document: toSave, version: saved.file.version }
      book.own.add(saved.file.version)
      // 存的过程中用户又改了：脏标记与草稿留给下一轮；没改就回到「显示服务端那份」
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
      // 版本对不上：拉最新的来比
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

  /** 用户改了一组：落进草稿、记下脏标记、排队保存。 */
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

  /** 撞车之后用户的选择：留我的（重放到最新版上再存），或用最新的（丢掉我这几组的改动）。 */
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

  // 离开时还有没存的就立刻存一次，不等停手计时
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
