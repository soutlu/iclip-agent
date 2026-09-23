import { useState } from 'react'
import { errorMessageOf } from '@/shared/api/client'
import { Icon } from '@/shared/icons'
import { Button } from '@/shared/ui/button'
import { DialogBody, DialogFooter } from '@/shared/ui/dialog'
import { Textarea } from '@/shared/ui/field'
import { InlineAlert } from '@/shared/ui/inline-alert'
import { MediaLightbox, type LightboxMedia } from '@/shared/ui/media-lightbox'
import { MenuItem, MenuRoot, MenuSurface, MenuTrigger } from '@/shared/ui/menu'
import type { TaskCreationAgents, TaskCreationDraft } from '../task-creation'
import { TaskVideoPreview } from './task-media-field'

type TaskCreationPreviewProps = {
  agents: TaskCreationAgents
  draft: TaskCreationDraft
  error: string | null
  blockedReason: string | null
  sending: boolean
  onBack: () => void
  onConfirm: (agentId: string) => void
}

/** 显示将被提交的原始消息和媒体；Agent 每次打开都不预选，选定名册里的一项才能开始。返回修改不会触发保存或运行。 */
export function TaskCreationPreview({
  agents,
  draft,
  error,
  blockedReason,
  sending,
  onBack,
  onConfirm,
}: TaskCreationPreviewProps) {
  const failure = blockedReason ?? error
  const [preview, setPreview] = useState<LightboxMedia | null>(null)
  const [agentId, setAgentId] = useState<string | null>(null)
  const text = draft.content.find((part) => part.type === 'text')?.text ?? ''
  const images = draft.content.filter((part) => part.type === 'image')
  const video = draft.content.find((part) => part.type === 'video')
  // 与首页同一口径：名册读取失败时不开始，选中项不在当前名册里也不算选定。
  const chosenAgent =
    agents.error === null ? (agents.items?.find((item) => item.id === agentId) ?? null) : null
  const agentLabel = agents.pending
    ? '正在加载 Agent…'
    : agents.error
      ? 'Agent 加载失败'
      : chosenAgent
        ? chosenAgent.name
        : agentId
          ? '所选 Agent 已不可用'
          : agents.items?.length
            ? '请选择 Agent'
            : '暂无可用 Agent'

  return (
    <>
      <DialogBody className="flex flex-col gap-5 px-6 pt-2 pb-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-body-sm text-on-surface-variant">来自「{draft.title}」</p>
          <MenuRoot>
            <MenuTrigger
              className="inline-flex h-(--control-height-md) max-w-48 ui-state items-center gap-1 rounded-full px-2 text-body font-medium text-on-surface ui-focus disabled:text-disabled-text"
              disabled={agents.pending || sending}
            >
              <span className="truncate">{agentLabel}</span>
              <Icon
                className="shrink-0 text-on-surface-variant"
                decorative
                name="expand"
                size="sm"
              />
            </MenuTrigger>
            <MenuSurface align="end">
              {agents.error ? (
                <>
                  <InlineAlert
                    className="max-w-64 px-3 py-2"
                    message={errorMessageOf(agents.error, '读取 Agent 列表失败')}
                  />
                  <MenuItem onSelect={agents.retry}>重新加载 Agent</MenuItem>
                </>
              ) : agents.items?.length ? (
                agents.items.map((item) => (
                  <MenuItem key={item.id} onSelect={() => setAgentId(item.id)}>
                    {item.name}
                  </MenuItem>
                ))
              ) : (
                <p className="px-3 py-2 text-body-sm text-on-surface-variant" role="status">
                  暂无可用 Agent
                </p>
              )}
            </MenuSurface>
          </MenuRoot>
        </div>
        <Textarea
          aria-label="发送文字预览"
          className="task-creation-text resize-none rounded-sm border-border ui-focus-inline"
          readOnly
          rows={13}
          value={text}
        />
        {images.length > 0 && (
          <section aria-label="参考图片" className="flex flex-col gap-3">
            <h3 className="text-body-sm font-semibold text-on-surface">
              参考图片（{images.length}）
            </h3>
            <div className="task-creation-images">
              {images.map((part, index) => (
                <button
                  key={part.source.url}
                  aria-label={`预览图片 ${index + 1}`}
                  className="aspect-square cursor-zoom-in overflow-hidden rounded-sm border border-border bg-surface-container-low ui-focus"
                  onClick={() =>
                    setPreview({ kind: 'image', url: part.source.url, name: `图片 ${index + 1}` })
                  }
                  type="button"
                >
                  <img
                    alt={`图片 ${index + 1}`}
                    className="size-full object-contain"
                    src={part.source.url}
                  />
                </button>
              ))}
            </div>
          </section>
        )}
        {video && (
          <section aria-label="参考视频" className="flex flex-col gap-3">
            <h3 className="text-body-sm font-semibold text-on-surface">参考视频</h3>
            <TaskVideoPreview
              url={video.source.url}
              name="参考视频"
              onOpen={() => setPreview({ kind: 'video', url: video.source.url, name: '参考视频' })}
            />
          </section>
        )}
        {failure && (
          <p className="text-body-sm text-error" role="alert">
            {failure}
          </p>
        )}
      </DialogBody>
      <DialogFooter>
        <Button disabled={sending} onClick={onBack} variant="outlined">
          返回修改
        </Button>
        <span className="text-caption text-on-surface-variant max-sm:hidden">将创建新的对话</span>
        <Button
          disabled={Boolean(blockedReason) || chosenAgent === null}
          loading={sending}
          onClick={() => {
            if (chosenAgent) onConfirm(chosenAgent.id)
          }}
        >
          确认并开始
        </Button>
      </DialogFooter>
      <MediaLightbox media={preview} onClose={() => setPreview(null)} />
    </>
  )
}
