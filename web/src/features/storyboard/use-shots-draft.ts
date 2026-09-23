/** 局部编辑、整份版本写回；冲突和失败保留草稿，保存期间的新修改继续提交。 */

import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ApiError, errorMessageOf, UserFacingError } from '@/shared/api/client'
import { readWorkspaceFile, workspaceQueryKeys, writeWorkspaceFile } from '@/shared/workbench'
import {
  parseShotsDocument,
  validateShotsDocument,
  type Shot,
  type ShotsDocument,
} from './shot-document'

const SAVE_DELAY_MS = 800

export type ShotConflict = { index: number; mine: Shot | undefined; theirs: Shot | undefined }
export type AspectConflict = { mine: string; theirs: string }
export type SaveState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved' }
  | { kind: 'error'; message: string }
  | { kind: 'conflict'; shots: ShotConflict[]; aspect?: AspectConflict }

/** 脏数据与冲突按「改了哪一处」记：镜头组用编号，整份分镜的画幅用这个键。 */
const ASPECT_KEY = 'aspect_ratio'
type DirtyKey = number | typeof ASPECT_KEY

const shotKeys = (keys: ReadonlySet<DirtyKey>): number[] =>
  [...keys].filter((key): key is number => key !== ASPECT_KEY)

type Base = { version: number; document: ShotsDocument }
/** 上传落进的那一格：镜头组编号、第几帧（从 1 数）与上传地址。 */
type UploadedFrame = { index: number; frame: number; url: string }
type UseShotsDraftOptions = {
  conversationId: string
  path: string
  file: { content: string; version: number } | undefined
}

const shotOf = (document: ShotsDocument, index: number) =>
  document.shots.find((shot) => shot.index === index)

const sameShot = (left: Shot | undefined, right: Shot | undefined) =>
  JSON.stringify(left ?? null) === JSON.stringify(right ?? null)

const changedKeys = (base: ShotsDocument, document: ShotsDocument) => {
  const keys = new Set<DirtyKey>(
    document.shots.flatMap((shot) =>
      sameShot(shot, shotOf(base, shot.index)) ? [] : [shot.index],
    ),
  )
  if (base.aspect_ratio !== document.aspect_ratio) keys.add(ASPECT_KEY)
  return keys
}

const replay = (latest: ShotsDocument, mine: ShotsDocument, dirty: ReadonlySet<DirtyKey>) => ({
  ...latest,
  aspect_ratio: dirty.has(ASPECT_KEY) ? mine.aspect_ratio : latest.aspect_ratio,
  shots: latest.shots.map((shot) =>
    dirty.has(shot.index) ? (shotOf(mine, shot.index) ?? shot) : shot,
  ),
})

const conflictingKeys = (
  base: ShotsDocument,
  latest: ShotsDocument,
  mine: ShotsDocument,
  dirty: ReadonlySet<DirtyKey>,
) => {
  const keys = new Set<DirtyKey>(
    shotKeys(dirty).filter(
      (index) =>
        !sameShot(shotOf(latest, index), shotOf(base, index)) &&
        !sameShot(shotOf(latest, index), shotOf(mine, index)),
    ),
  )
  if (
    dirty.has(ASPECT_KEY) &&
    latest.aspect_ratio !== base.aspect_ratio &&
    latest.aspect_ratio !== mine.aspect_ratio
  )
    keys.add(ASPECT_KEY)
  return keys
}

/** 调用方按对话与文件路径挂载，避免不同文件共用一个编辑生命周期。 */
export const useShotsDraft = ({ conversationId, file, path }: UseShotsDraftOptions) => {
  const queryClient = useQueryClient()
  const content = file?.content
  const parsed = useMemo(
    () => (content === undefined ? null : parseShotsDocument(content)),
    [content],
  )
  const [edited, setEdited] = useState<ShotsDocument | null>(null)
  const [state, setState] = useState<SaveState>({ kind: 'idle' })
  // 只用来在保存失败时说清图片已经传上去了；同一格只记最后一次。
  const [uploads, setUploads] = useState<readonly UploadedFrame[]>([])
  const ledgerRef = useRef({
    base: null as Base | null,
    edited: null as ShotsDocument | null,
    dirty: new Set<DirtyKey>(),
    latest: null as Base | null,
    conflicts: new Set<DirtyKey>(),
    inFlight: null as Promise<ShotsDocument | null> | null,
    timer: null as ReturnType<typeof setTimeout> | null,
  })

  useEffect(() => {
    const book = ledgerRef.current
    if (file === undefined || parsed === null || book.dirty.size > 0 || book.inFlight !== null)
      return
    if (book.base === null || file.version >= book.base.version) {
      book.base = { document: parsed, version: file.version }
    }
  }, [file, parsed])

  const clearTimer = useCallback(() => {
    const book = ledgerRef.current
    if (book.timer !== null) clearTimeout(book.timer)
    book.timer = null
  }, [])

  const showConflict = useCallback(() => {
    const book = ledgerRef.current
    if (book.latest === null || book.edited === null) return
    const latest = book.latest.document
    const mine = book.edited
    setState({
      kind: 'conflict',
      shots: shotKeys(book.conflicts).map((index) => ({
        index,
        mine: shotOf(mine, index),
        theirs: shotOf(latest, index),
      })),
      ...(book.conflicts.has(ASPECT_KEY)
        ? { aspect: { mine: mine.aspect_ratio, theirs: latest.aspect_ratio } }
        : {}),
    })
  }, [])

  /** 立刻写回；返回此刻已落盘的文档，保存失败、有冲突或尚未读到文件时为 null。 */
  const saveNow = useCallback((): Promise<ShotsDocument | null> => {
    const book = ledgerRef.current
    clearTimer()
    if (book.inFlight !== null) return book.inFlight
    if (book.latest !== null) {
      showConflict()
      return Promise.resolve(null)
    }
    if (book.base === null) return Promise.resolve(null)
    if (book.edited === null || book.dirty.size === 0) return Promise.resolve(book.base.document)

    const run = async (): Promise<ShotsDocument | null> => {
      let rebased = false
      let landed: ShotsDocument | null = null
      while (book.edited !== null && book.dirty.size > 0 && book.base !== null) {
        const mine = book.edited
        const base = book.base
        const problem = validateShotsDocument(mine)
        if (problem !== undefined) {
          clearTimer()
          setState({ kind: 'error', message: problem })
          return null
        }
        setState({ kind: 'saving' })
        try {
          const saved = await writeWorkspaceFile(conversationId, {
            content: JSON.stringify(mine, null, 2),
            expectedVersion: base.version,
            path,
          })
          book.base = { document: mine, version: saved.file.version }
          landed = mine
          // 请求中的快照已落盘。后续编辑仍以最新草稿为准，不能被这次响应清除。
          const current = book.edited ?? mine
          book.dirty = changedKeys(mine, current)
          book.edited = book.dirty.size === 0 ? null : current
          setEdited(book.edited)
          queryClient.setQueryData(workspaceQueryKeys.file(conversationId, path), saved)
        } catch (error) {
          if (!(error instanceof ApiError) || error.status !== 409 || rebased) {
            clearTimer()
            setState({ kind: 'error', message: errorMessageOf(error, '保存失败') })
            return null
          }
          const latestFile = await queryClient.fetchQuery({
            queryFn: ({ signal }) => readWorkspaceFile(conversationId, path, signal),
            queryKey: workspaceQueryKeys.file(conversationId, path),
            staleTime: 0,
          })
          const latestDocument = parseShotsDocument(latestFile.file.content)
          if (latestDocument === null) {
            clearTimer()
            setState({ kind: 'error', message: '最新文件格式不正确，草稿已保留' })
            return null
          }
          const latest: Base = { document: latestDocument, version: latestFile.file.version }
          const current = book.edited ?? mine
          const conflicts = conflictingKeys(base.document, latest.document, current, book.dirty)
          if (conflicts.size > 0) {
            book.latest = latest
            book.conflicts = conflicts
            clearTimer()
            showConflict()
            return null
          }
          const merged = replay(latest.document, current, book.dirty)
          book.base = latest
          book.dirty = changedKeys(latest.document, merged)
          book.edited = book.dirty.size === 0 ? null : merged
          setEdited(book.edited)
          rebased = true
        }
      }
      clearTimer()
      setState({ kind: 'saved' })
      return landed
    }

    book.inFlight = run()
      .catch((error: unknown) => {
        clearTimer()
        setState({ kind: 'error', message: errorMessageOf(error, '保存失败') })
        return null
      })
      .finally(() => {
        book.inFlight = null
      })
      .then((landed) => (landed !== null && book.dirty.size === 0 ? landed : null))
    return book.inFlight
  }, [clearTimer, conversationId, path, queryClient, showConflict])

  /** 把一处改动记进草稿：标脏、有待处理的最新版本先对账，没冲突才排下一次延迟保存。 */
  const commit = useCallback(
    (document: ShotsDocument, key: DirtyKey) => {
      const book = ledgerRef.current
      book.edited = document
      book.dirty.add(key)
      setEdited(document)
      clearTimer()
      if (book.latest !== null && book.base !== null) {
        const latest = book.latest
        book.conflicts = conflictingKeys(book.base.document, latest.document, document, book.dirty)
        if (book.conflicts.size > 0) {
          showConflict()
          return
        }
        // 冲突期间也可能收到其它组的上传结果；始终重新对账，不能绕过同组冲突。
        const merged = replay(latest.document, document, book.dirty)
        book.base = latest
        book.latest = null
        book.dirty = changedKeys(latest.document, merged)
        book.edited = book.dirty.size === 0 ? null : merged
        setEdited(book.edited)
      }
      setState(book.inFlight === null ? { kind: 'idle' } : { kind: 'saving' })
      book.timer = setTimeout(() => void saveNow(), SAVE_DELAY_MS)
    },
    [clearTimer, saveNow, showConflict],
  )

  const updateShot = useCallback(
    (index: number, update: (current: Shot) => Shot): Shot | undefined => {
      const book = ledgerRef.current
      const current = book.edited ?? book.base?.document
      const shot = current === undefined ? undefined : shotOf(current, index)
      if (current === undefined || shot === undefined) {
        setState({ kind: 'error', message: '这个镜头组已不存在，请重新读取分镜' })
        return undefined
      }
      const next = update(shot)
      if (sameShot(shot, next)) return next
      if (next.index !== index) throw new Error('编辑不能更改镜头组编号')
      commit(
        { ...current, shots: current.shots.map((item) => (item.index === index ? next : item)) },
        index,
      )
      return next
    },
    [commit],
  )

  /** 画幅是整份分镜的声明，和镜头正文走同一条草稿链路，只是脏数据记在文档级的键上。 */
  const updateAspectRatio = useCallback(
    (aspectRatio: string) => {
      const book = ledgerRef.current
      const current = book.edited ?? book.base?.document
      if (current === undefined || current.aspect_ratio === aspectRatio) return
      commit({ ...current, aspect_ratio: aspectRatio }, ASPECT_KEY)
    },
    [commit],
  )

  const replaceFrame = useCallback(
    (index: number, frame: number, previousUrl: string, url: string) => {
      const result = updateShot(index, (shot) => {
        if (!Number.isInteger(frame) || frame < 1 || shot.image_urls[frame - 1] !== previousUrl) {
          throw new UserFacingError('这张图片已发生变化，请重新选择要替换的图片')
        }
        return {
          ...shot,
          image_urls: shot.image_urls.map((image, position) =>
            position === frame - 1 ? url : image,
          ),
        }
      })
      if (result === undefined) throw new UserFacingError('目标镜头组已不存在，上传结果未写入分镜')
    },
    [updateShot],
  )

  /** 候选图写入成功才算应用；失败只撤回本次图片替换，保留其它草稿与冲突。 */
  const applyFrame = useCallback(
    async (index: number, frame: number, previousUrl: string, url: string) => {
      const book = ledgerRef.current
      if (book.inFlight !== null) throw new UserFacingError('当前修改正在保存，请稍后重试')
      if (book.latest !== null) throw new UserFacingError('分镜存在版本冲突，请先处理冲突')
      const current = book.edited ?? book.base?.document
      const target = current === undefined ? undefined : shotOf(current, index)
      const replaced = target?.image_urls[frame - 1] !== url
      if (replaced) replaceFrame(index, frame, previousUrl, url)
      if ((await saveNow()) === null) {
        const currentDraft = book.edited
        const currentShot = currentDraft === null ? undefined : shotOf(currentDraft, index)
        // 保存期间发生的文字编辑和其它图片变化不属于本次失败，不能整份回滚。
        if (replaced && currentDraft !== null && currentShot?.image_urls[frame - 1] === url) {
          const restored = {
            ...currentShot,
            image_urls: currentShot.image_urls.map((image, position) =>
              position === frame - 1 ? previousUrl : image,
            ),
          }
          const restoredDocument = {
            ...currentDraft,
            shots: currentDraft.shots.map((shot) => (shot.index === index ? restored : shot)),
          }
          if (
            book.latest === null &&
            book.base !== null &&
            sameShot(restored, shotOf(book.base.document, index))
          )
            book.dirty.delete(index)
          book.edited = book.dirty.size === 0 ? null : restoredDocument
          setEdited(book.edited)
          setState((previous) =>
            previous.kind === 'conflict'
              ? {
                  ...previous,
                  shots: previous.shots.map((conflict) =>
                    conflict.index === index ? { ...conflict, mine: restored } : conflict,
                  ),
                }
              : previous,
          )
        }
        throw new UserFacingError('图片尚未保存，请处理保存错误或冲突后重试')
      }
    },
    [replaceFrame, saveNow],
  )

  /** 记下这一格刚换成了上传的图；不改草稿，只影响 `hasUnsavedUpload`。 */
  const recordUpload = useCallback((index: number, frame: number, url: string) => {
    setUploads((current) => [
      ...current.filter((upload) => upload.index !== index || upload.frame !== frame),
      { index, frame, url },
    ])
  }, [])

  const resolveConflict = useCallback(
    (choice: 'mine' | 'theirs') => {
      const book = ledgerRef.current
      // 用最新的就不再提上传过什么，不管下面有没有真正换掉草稿。
      if (choice === 'theirs') setUploads([])
      const latest = book.latest
      const mine = book.edited
      if (latest === null || mine === null) return
      if (choice === 'theirs') {
        for (const key of book.conflicts) book.dirty.delete(key)
      } else if (
        shotKeys(book.dirty).some((index) => shotOf(latest.document, index) === undefined)
      ) {
        setState({
          kind: 'error',
          message: '原镜头组已从最新文件移除，无法按原编号覆盖；草稿已保留',
        })
        return
      }
      const merged = replay(latest.document, mine, book.dirty)
      book.latest = null
      book.conflicts.clear()
      book.base = latest
      book.dirty = changedKeys(latest.document, merged)
      book.edited = book.dirty.size === 0 ? null : merged
      setEdited(book.edited)
      setState({ kind: 'idle' })
      if (book.edited !== null) void saveNow()
    },
    [saveNow],
  )

  useEffect(
    () => () => {
      if (ledgerRef.current.timer !== null) void saveNow()
    },
    [saveNow],
  )

  // 按已落盘的文件内容判断，不看哪次请求成功：较早的一次保存成功不能抹掉后来那张图的提示。
  const hasUnsavedUpload =
    edited !== null &&
    uploads.some(
      ({ index, frame, url }) =>
        shotOf(edited, index)?.image_urls[frame - 1] === url &&
        (parsed === null ? undefined : shotOf(parsed, index))?.image_urls[frame - 1] !== url,
    )

  return {
    applyFrame,
    document: edited ?? parsed,
    hasUnsavedChanges: edited !== null,
    /** 草稿里有记过的上传图，而已落盘的文件那一格还不是它。 */
    hasUnsavedUpload,
    state,
    updateAspectRatio,
    updateShot,
    recordUpload,
    replaceFrame,
    resolveConflict,
    saveNow,
  }
}
