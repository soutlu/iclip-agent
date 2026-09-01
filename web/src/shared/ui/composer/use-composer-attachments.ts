/**
 * Composer 附件的状态机：本地 entry、上传管线（签名 → OSS 直传 → 登记）与预览地址回收。
 *
 * 照 kimi 网页版的附件生命周期：文件进来先建 entry 并立刻起传，pill 同时落进文档；文档
 * 不再引用某 entry 时（退格删掉、整篇清空）由 `syncReferences` 回收它的本地预览。上传进度
 * 只在悬停卡里看，pill 本体不画进度。entry 只随文档生灭，没有单独的「移除 entry」入口。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { z } from 'zod'
import { apiFetch } from '@/shared/api/client'
import { zAssetEnvelope, zUploadTicketOut } from '@/shared/api/generated/zod.gen'

/** 附件种类：image/video 能上行进 prompt；file 永远走不到 ready（签名不收，停在 error）。 */
export type ComposerAttachmentKind = 'file' | 'image' | 'video'

export type ComposerAttachment = {
  readonly attId: string
  readonly kind: ComposerAttachmentKind
  readonly name: string
  readonly size: number
  readonly mediaType: string
  readonly status: 'error' | 'ready' | 'uploading'
  /** 上传进度 0..1，只在直传进行中有值（照 kimi：百分比变化才写，非 100% 时节流）。 */
  readonly progress: number | undefined
  /** 预览地址：上传中是本地 blob://，ready 后是资产公网地址。 */
  readonly previewUrl: string | undefined
  /** 登记后的公网地址，发送用。 */
  readonly url: string | undefined
  /** 失败原因：接口原文文案。 */
  readonly error: string | undefined
}

/** 进度回写节流：百分比变化才写，非 100% 时距上次至少 120ms（照 kimi）。 */
const PROGRESS_WRITE_MS = 120

/** 附件 id：8 位 base36 随机串（照 kimi 的 `Pu()`）。 */
const mintAttachmentId = (): string => Math.random().toString(36).slice(2, 10)

/** 按 MIME 前缀分类（照 kimi 的 tZ）：image/ → image，video/ → video，其余 → file。 */
const kindOf = (mediaType: string): ComposerAttachmentKind =>
  mediaType.startsWith('image/') ? 'image' : mediaType.startsWith('video/') ? 'video' : 'file'

/** 本地预览地址；环境给不出（jsdom、Worker 里的怪 URL 实现）就没有。 */
const previewUrlOf = (kind: ComposerAttachmentKind, file: File): string | undefined => {
  if (kind === 'file' || typeof URL.createObjectURL !== 'function') return undefined
  try {
    return URL.createObjectURL(file)
  } catch {
    return undefined
  }
}

/** 回收本地预览地址；公网地址不是这里发的，不动。 */
const revokePreview = (entry: ComposerAttachment) => {
  if (entry.previewUrl?.startsWith('blob:') === true) URL.revokeObjectURL(entry.previewUrl)
}

type UploadInstruction = z.infer<typeof zUploadTicketOut>['upload']

/**
 * OSS 预签名直传 PUT（合同允许的裸请求豁免之一）。用 XHR 而不用 fetch 只为拿上传进度
 * （照 kimi 的 postFormXhr）；headers 原样带上——Content-Type 签在签名里，换了验签不过。
 */
const putWithProgress = (
  upload: UploadInstruction,
  file: File,
  onProgress: (ratio: number) => void,
): Promise<void> =>
  new Promise((resolve, reject) => {
    const request = new XMLHttpRequest()
    request.open('PUT', upload.url)
    for (const [name, value] of Object.entries(upload.headers)) {
      request.setRequestHeader(name, value)
    }
    request.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable && event.total > 0) onProgress(event.loaded / event.total)
    })
    request.addEventListener('load', () => {
      if (request.status >= 200 && request.status < 300) resolve()
      else reject(new Error(`上传失败（${request.status}）`))
    })
    request.addEventListener('error', () => reject(new Error('网络错误，上传失败')))
    request.addEventListener('abort', () => reject(new Error('上传已取消')))
    request.send(file)
  })

/**
 * 管理 composer 的附件 entry。
 *
 * @returns entry 表与一组操作；`entries` 是状态，操作函数随渲染刷新闭包。
 */
export const useComposerAttachments = () => {
  const [entries, setEntries] = useState<ReadonlyMap<string, ComposerAttachment>>(() => new Map())
  const entriesRef = useRef(entries)
  useEffect(() => {
    entriesRef.current = entries
  }, [entries])
  // 卸载时回收所有还活着的本地预览
  useEffect(
    () => () => {
      for (const entry of entriesRef.current.values()) revokePreview(entry)
    },
    [],
  )

  /** 改单个 entry；entry 已被回收（pill 删了、上传才回来）就直接丢弃这次回写。 */
  const patch = (attId: string, partial: Partial<ComposerAttachment>) => {
    setEntries((prev) => {
      const current = prev.get(attId)
      if (current === undefined) return prev
      const next = new Map(prev)
      next.set(attId, { ...current, ...partial })
      return next
    })
  }

  /** 一份文件的完整上传管线；任何一步失败都让 entry 进 error 态，文案存接口原文。 */
  const upload = async (entry: ComposerAttachment, file: File) => {
    try {
      // 图片签名必须报宽高（「传图要报宽高」）；读不出尺寸就不带，让服务端 422 替它说话
      let width: number | null = null
      let height: number | null = null
      if (entry.kind === 'image' && typeof createImageBitmap === 'function') {
        try {
          const bitmap = await createImageBitmap(file)
          width = bitmap.width
          height = bitmap.height
          bitmap.close()
        } catch {
          width = null
          height = null
        }
      }
      const ticket = await apiFetch('/uploads/sign', zUploadTicketOut, {
        body: { contentType: entry.mediaType, height, width },
        fallbackErrorMessage: '上传失败',
        method: 'POST',
      })

      let lastPercent = -1
      let lastWrittenAt = 0
      await putWithProgress(ticket.upload, file, (ratio) => {
        const percent = Math.floor(ratio * 100)
        const now = Date.now()
        if (percent === lastPercent) return
        if (percent < 100 && now - lastWrittenAt < PROGRESS_WRITE_MS) return
        lastPercent = percent
        lastWrittenAt = now
        patch(entry.attId, { progress: ratio })
      })

      const envelope = await apiFetch(`/assets/${ticket.assetId}`, zAssetEnvelope, {
        fallbackErrorMessage: '上传失败',
        method: 'POST',
      })
      setEntries((prev) => {
        const current = prev.get(entry.attId)
        if (current === undefined) return prev
        revokePreview(current)
        const next = new Map(prev)
        // 预览换成公网地址：发送之后本地这份预览仍然是可看的（kimi 靠 fileId 回拉，我们直接换地址）
        next.set(entry.attId, {
          ...current,
          previewUrl: envelope.asset.url,
          progress: undefined,
          status: 'ready',
          url: envelope.asset.url,
        })
        return next
      })
    } catch (error) {
      patch(entry.attId, {
        error: error instanceof Error ? error.message : '上传失败',
        progress: undefined,
        status: 'error',
      })
    }
  }

  /**
   * 给一份文件建 entry 并立刻起传。返回 entry 供调用方把 pill 插进文档。
   *
   * @param file - 拖入 / 粘贴 / 选中的文件。
   * @returns 新建的上传中 entry。
   */
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

  /**
   * refCount 对账（照 kimi：文档不再引用的 entry 删掉并回收预览）。文档是 pill 的唯一事实源，
   * 每次 doc 变化后由编辑器那边喂进来当前的 attId 列表。
   *
   * @param attIdsInDoc - 文档当前引用的附件 id。
   */
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

  /**
   * 按文档顺序取可发送的附件（ready 且有公网地址）。
   *
   * @param attIdsInDoc - 文档当前引用的附件 id（有序）。
   * @returns 可上行的附件，顺序即文档顺序。
   */
  const takeReady = (attIdsInDoc: readonly string[]): ComposerAttachment[] =>
    attIdsInDoc.flatMap((attId) => {
      const entry = entries.get(attId)
      return entry !== undefined && entry.status === 'ready' && entry.url !== undefined
        ? [entry]
        : []
    })

  /**
   * 发送失败时把附件还回来：entry 重新登记（已 ready 的不重传，地址还在）。
   *
   * @param list - 当时发出去的那批附件快照。
   */
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

/** 一次提交的内容：用户打的字 + 可发送的附件（按文档顺序）。 */
export type ComposerSubmission = {
  readonly text: string
  readonly media: readonly ComposerAttachment[]
}
