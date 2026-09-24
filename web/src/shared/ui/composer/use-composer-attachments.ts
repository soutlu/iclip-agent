/** 文档是附件生命周期的事实源；新增即上传，引用消失时由 syncReferences 回收条目与本地预览。上传协议与校验在 shared/api/media-upload。 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { errorMessageOf } from '@/shared/api/client'
import { uploadMediaFile } from '@/shared/api/media-upload'

/** image / video 可提交给 prompt；file 不上传，直接停在 error。 */
export type ComposerAttachmentKind = 'file' | 'image' | 'video'

export type ComposerAttachment = {
  readonly attId: string
  readonly kind: ComposerAttachmentKind
  readonly name: string
  /** 字节数；从公网地址恢复的附件没有此信息。 */
  readonly size: number | undefined
  readonly mediaType: string
  readonly status: 'error' | 'ready' | 'uploading'
  /** 直传期间的进度值为 0–1，按百分比变化节流更新。 */
  readonly progress: number | undefined
  /** 上传中使用本地 blob URL，就绪后使用公网地址。 */
  readonly previewUrl: string | undefined
  readonly url: string | undefined
  readonly error: string | undefined
}

/** 百分比变化且距上次至少 120ms 才更新；100% 不节流。 */
const PROGRESS_WRITE_MS = 120

const UNSUPPORTED_FILE = '只能添加图片或视频附件'

/** 参考 Kimi Pu()，使用八位 base36 随机附件 ID。 */
const mintAttachmentId = (): string => Math.random().toString(36).slice(2, 10)

/** 复用公网媒体地址创建就绪附件，无需重新上传。 */
export const readyAttachment = ({
  kind,
  name,
  url,
}: {
  kind: ComposerAttachmentKind
  name: string
  url: string
}): ComposerAttachment => ({
  attId: mintAttachmentId(),
  error: undefined,
  kind,
  mediaType: `${kind}/*`,
  name,
  previewUrl: url,
  progress: undefined,
  size: undefined,
  status: 'ready',
  url,
})

/** 按 MIME 前缀区分 image、video 与 file。 */
const kindOf = (mediaType: string): ComposerAttachmentKind =>
  mediaType.startsWith('image/') ? 'image' : mediaType.startsWith('video/') ? 'video' : 'file'

/** 环境不支持对象 URL 时不生成本地预览。 */
const previewUrlOf = (kind: ComposerAttachmentKind, file: File): string | undefined => {
  if (kind === 'file' || typeof URL.createObjectURL !== 'function') return undefined
  try {
    return URL.createObjectURL(file)
  } catch {
    return undefined
  }
}

/** 仅回收本地对象 URL，不撤销公网地址。 */
const revokePreview = (entry: ComposerAttachment) => {
  if (entry.previewUrl?.startsWith('blob:') === true) URL.revokeObjectURL(entry.previewUrl)
}

export const useComposerAttachments = () => {
  const [entries, setEntries] = useState<ReadonlyMap<string, ComposerAttachment>>(() => new Map())
  const entriesRef = useRef(entries)
  useEffect(() => {
    entriesRef.current = entries
  }, [entries])
  useEffect(
    () => () => {
      for (const entry of entriesRef.current.values()) revokePreview(entry)
    },
    [],
  )

  /** 忽略已回收条目的异步回写，避免删除后重新出现。 */
  const patch = (attId: string, partial: Partial<ComposerAttachment>) => {
    setEntries((prev) => {
      const current = prev.get(attId)
      if (current === undefined) return prev
      const next = new Map(prev)
      next.set(attId, { ...current, ...partial })
      return next
    })
  }

  /** 任一步上传失败均进入 error 状态并保留可展示的错误文案。 */
  const upload = async (entry: ComposerAttachment, file: File) => {
    const { kind } = entry
    if (kind === 'file') {
      patch(entry.attId, { error: UNSUPPORTED_FILE, status: 'error' })
      return
    }
    let lastPercent = -1
    let lastWrittenAt = 0
    const onProgress = (ratio: number) => {
      const percent = Math.floor(ratio * 100)
      const now = Date.now()
      if (percent === lastPercent) return
      if (percent < 100 && now - lastWrittenAt < PROGRESS_WRITE_MS) return
      lastPercent = percent
      lastWrittenAt = now
      patch(entry.attId, { progress: ratio })
    }
    try {
      const url = await uploadMediaFile(file, kind, { onProgress })
      setEntries((prev) => {
        const current = prev.get(entry.attId)
        if (current === undefined) return prev
        revokePreview(current)
        const next = new Map(prev)
        // 上传后将预览替换为公网地址，保证本地 URL 回收后仍可查看。
        next.set(entry.attId, {
          ...current,
          previewUrl: url,
          progress: undefined,
          status: 'ready',
          url,
        })
        return next
      })
    } catch (error) {
      patch(entry.attId, {
        error: errorMessageOf(error, '上传失败'),
        progress: undefined,
        status: 'error',
      })
    }
  }

  const mintEntry = (file: File): ComposerAttachment => {
    const kind = kindOf(file.type)
    const entry: ComposerAttachment = {
      attId: mintAttachmentId(),
      error: undefined,
      kind,
      mediaType: file.type === '' ? `${kind}/*` : file.type,
      name: file.name,
      previewUrl: previewUrlOf(kind, file),
      progress: undefined,
      size: file.size,
      status: 'uploading',
      url: undefined,
    }
    setEntries((prev) => new Map(prev).set(entry.attId, entry))
    void upload(entry, file)
    return entry
  }

  /** 每次文档变化后提供当前附件 ID；删除无引用条目并回收其预览。 */
  const syncReferences = useCallback((attIdsInDoc: readonly string[]) => {
    setEntries((prev) => {
      const live = new Set(attIdsInDoc)
      let changed = false
      const next = new Map(prev)
      for (const [attId, entry] of prev) {
        if (live.has(attId)) continue
        changed = true
        next.delete(attId)
        revokePreview(entry)
      }
      return changed ? next : prev
    })
  }, [])

  /** 按文档顺序返回已就绪且具备公网地址的附件。 */
  const takeReady = (attIdsInDoc: readonly string[]): ComposerAttachment[] =>
    attIdsInDoc.flatMap((attId) => {
      const entry = entries.get(attId)
      return entry !== undefined && entry.status === 'ready' && entry.url !== undefined
        ? [entry]
        : []
    })

  /** 恢复发送时的附件快照，已就绪条目不重新上传。 */
  const restoreEntries = useCallback((list: readonly ComposerAttachment[]) => {
    setEntries((prev) => {
      const next = new Map(prev)
      for (const entry of list) next.set(entry.attId, entry)
      return next
    })
  }, [])

  return { entries, mintEntry, restoreEntries, syncReferences, takeReady }
}

export type ComposerAttachments = ReturnType<typeof useComposerAttachments>

export type ComposerPart =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'media'; readonly media: ComposerAttachment }

/** parts 保留文字与附件顺序，用于提交；text / media 为气泡占位与失败恢复提供平铺视图。 */
export type ComposerSubmission = {
  readonly text: string
  readonly media: readonly ComposerAttachment[]
  readonly parts: readonly ComposerPart[]
}
