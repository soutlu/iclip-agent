import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import { Check, LockKeyhole, Pencil, Play, X } from 'lucide-react'
import type {
  StoryboardCreativeInput,
  StoryboardCreativeOverview,
  StoryboardInputVideo,
  Storyboard,
  StoryboardStatus,
} from '@/features/storyboards/model/storyboard-workspace'
import { STORYBOARD_STATUS_LABELS } from '@/features/storyboards/components/storyboard-status'
import type { StoryboardAgentRun } from '@/features/storyboards/runtime/storyboard-agent'
import {
  MediaPreviewDialog,
  MediaThumbnailSurface,
  type MediaPreviewItem,
  useMediaPreview,
} from '@/shared/ui/media'

const CREATIVE_BRIEF_ROWS: Array<{
  key: keyof StoryboardCreativeOverview
  label: string
  labelEn: string
  primary?: boolean
}> = [
  { key: 'theme', label: '主题', labelEn: 'Theme', primary: true },
  { key: 'purpose', label: '目的', labelEn: 'Purpose' },
  { key: 'audience', label: '目标受众', labelEn: 'Audience' },
  { key: 'selling', label: '商业卖点', labelEn: 'Selling' },
  { key: 'scene', label: '使用场景', labelEn: 'Scene' },
]

export type EditableStoryboardBrief = StoryboardCreativeOverview

const EDITABLE_BRIEF_FIELDS: Array<{
  key: keyof EditableStoryboardBrief
  label: string
}> = [
  { key: 'theme', label: '主题' },
  { key: 'purpose', label: '目的' },
  { key: 'audience', label: '目标受众' },
  { key: 'selling', label: '商业卖点' },
  { key: 'scene', label: '使用场景' },
]

type StoryboardBriefPanelProps = {
  agentRun: StoryboardAgentRun | null
  onConfirm: () => void
  onOpenChange: (open: boolean) => void
  onOpenRunRecord: () => void
  onSave: (brief: EditableStoryboardBrief) => void
  onSubmit: () => void
  open: boolean
  storyboard: Pick<
    Storyboard,
    'confirmedAt' | 'conversationId' | 'creativeInput' | 'status' | 'title'
  > & {
    shots: Array<{ id: string }>
  }
}

const getBriefActionHint = (status: StoryboardStatus, agentRun: StoryboardAgentRun | null) => {
  if (agentRun?.phase === 'failed') {
    return '上次运行失败，确认 Brief 后可重新提交'
  }
  if (status === 'draft') {
    return '先确认 Brief，再提交创作任务'
  }

  if (agentRun?.phase === 'running') {
    return '任务已进入制作队列，执行进度显示在时间线上方'
  }
  if (agentRun?.phase === 'completed') {
    return '任务已完成，可在时间线上方查看 Agent 输出'
  }
  if (status === 'confirmed') {
    return 'Brief 已确认，点击提交进入制作队列'
  }

  return '任务已提交，正在等待 Agent 接收'
}

/**
 * 把画幅比例文案转换为 CSS `aspect-ratio` 值。
 *
 * @param value - 形如 “16:9” 的画幅文案。
 * @returns 形如 “16 / 9” 的 CSS 比例值。
 */
const aspectRatioCss = (value: string) => {
  const [width = 0, height = 0] = value.split(':').map((part) => Number(part.trim()))
  return width > 0 && height > 0 ? `${width} / ${height}` : '16 / 9'
}

const createEditableBrief = (creativeInput: StoryboardCreativeInput): EditableStoryboardBrief => ({
  audience: creativeInput.audience,
  purpose: creativeInput.purpose,
  scene: creativeInput.scene,
  selling: creativeInput.selling,
  theme: creativeInput.theme,
})

/**
 * 把 Storyboard 参考视频转换为共享媒体预览合同。
 *
 * @param video - 当前 Brief 中的参考视频。
 * @returns 可交给共享视频播放器的预览项。
 */
const createVideoPreviewItem = (video: StoryboardInputVideo): MediaPreviewItem => ({
  attachmentId: video.id,
  fileName: video.title,
  mediaType: 'video',
  url: video.previewUrl,
})

/**
 * 渲染设计稿中的创作 Brief 面板，并集中管理确认与提交门禁。
 *
 * @param props - 当前 Storyboard、运行状态和 Brief 操作。
 * @returns 可滚动的 Brief 主体与固定底部操作区。
 */
export default function StoryboardBriefPanel({
  agentRun,
  onConfirm,
  onOpenChange,
  onOpenRunRecord,
  onSave,
  onSubmit,
  open,
  storyboard,
}: StoryboardBriefPanelProps) {
  const creativeInput = storyboard.creativeInput
  const heroVideo = creativeInput.referenceVideos[0]
  const confirmed = storyboard.status !== 'draft'
  const hasRunRecord = agentRun !== null
  const runLive = agentRun?.phase === 'running'
  const submitted = storyboard.status === 'submitted' || runLive || agentRun?.phase === 'completed'
  const [editing, setEditing] = useState(false)
  const [editableBrief, setEditableBrief] = useState(() => createEditableBrief(creativeInput))
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const editButtonRef = useRef<HTMLButtonElement>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)
  const { closePreview, openPreview, preview } = useMediaPreview()

  const closeEditor = () => {
    setEditableBrief(createEditableBrief(creativeInput))
    setEditing(false)
    editButtonRef.current?.focus()
  }

  const handleVideoPreviewKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    video: StoryboardInputVideo,
  ) => {
    if (event.key !== 'Enter' && event.key !== ' ') {
      return
    }

    event.preventDefault()
    openPreview(createVideoPreviewItem(video))
  }

  useEffect(() => {
    setEditing(false)
    setEditableBrief(createEditableBrief(creativeInput))
  }, [creativeInput, storyboard.conversationId])

  useEffect(() => {
    if (!open) return

    previousFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    closeButtonRef.current?.focus()

    return () => {
      previousFocusRef.current?.focus()
      previousFocusRef.current = null
    }
  }, [open])

  return (
    <>
      <aside
        className="storyboards-brief-panel"
        aria-label="创作输入"
        aria-hidden={!open}
        aria-modal="true"
        data-open={open || undefined}
        inert={!open}
        role="dialog"
        onKeyDown={(event) => {
          if (event.key !== 'Escape') {
            return
          }

          onOpenChange(false)
        }}
      >
        <div className="storyboards-brief-panel-heading">
          <span className="storyboards-section-label">创作输入</span>
          <span className="storyboards-brief-panel-heading-actions">
            <span className="storyboards-brief-status" data-status={storyboard.status}>
              <i aria-hidden="true" />
              {STORYBOARD_STATUS_LABELS[storyboard.status]}
            </span>
            <button
              aria-label="关闭创作 Brief"
              className="storyboards-brief-close"
              onClick={() => onOpenChange(false)}
              ref={closeButtonRef}
              type="button"
            >
              <X aria-hidden="true" size={15} strokeWidth={1.8} />
            </button>
          </span>
        </div>

        <section className="storyboards-brief-body" aria-label="结构化创作输入">
          {heroVideo ? (
            <button
              aria-label={`双击查看${heroVideo.title}`}
              className="storyboards-brief-hero"
              data-video-preview-trigger
              onDoubleClick={() => openPreview(createVideoPreviewItem(heroVideo))}
              onKeyDown={(event) => handleVideoPreviewKeyDown(event, heroVideo)}
              style={
                {
                  '--storyboard-hero-ar': aspectRatioCss(heroVideo.aspectRatio),
                } as CSSProperties
              }
              title="双击查看视频"
              type="button"
            >
              <MediaThumbnailSurface
                className="storyboards-brief-hero-cover"
                fileName={heroVideo.title}
                mediaType="video"
                url={heroVideo.previewUrl}
              />
              <span className="storyboards-brief-hero-play" aria-hidden="true">
                <Play size={12} strokeWidth={0} fill="currentColor" />
              </span>
              <span className="storyboards-brief-hero-tag">
                <strong>创作 Brief</strong>
                <i aria-hidden="true">·</i>
                款号 {creativeInput.styleNo ?? creativeInput.category}
              </span>
            </button>
          ) : (
            <div className="storyboards-brief-heading">
              <strong>创作 Brief</strong>
              <i aria-hidden="true">·</i>
              <span>款号 {creativeInput.styleNo ?? creativeInput.category}</span>
            </div>
          )}

          <div className="storyboards-brief-rows">
            {CREATIVE_BRIEF_ROWS.map((field, index) => (
              <div
                key={field.key}
                className="storyboards-brief-row"
                data-primary={field.primary || undefined}
              >
                <div className="storyboards-brief-row-label">
                  <span className="storyboards-brief-row-num" aria-hidden="true">
                    {String(index + 1).padStart(2, '0')}
                  </span>
                  <strong>{field.label}</strong>
                  <small>{field.labelEn}</small>
                </div>
                <p className="storyboards-brief-row-value">{creativeInput[field.key]}</p>
              </div>
            ))}
          </div>

          <div className="storyboards-brief-detail">
            <section>
              <div className="storyboards-brief-detail-heading">
                <span className="storyboards-brief-detail-index" aria-hidden="true">
                  06
                </span>
                <strong>
                  参考图 <small>REF · {creativeInput.referenceImages.length} 张</small>
                </strong>
              </div>
              <ul
                className="storyboards-brief-reference-images"
                aria-label={`${creativeInput.referenceImages.length} 张参考图`}
              >
                {creativeInput.referenceImages.map((image) => (
                  <li key={image.id}>
                    <img className="media-natural-ratio" src={image.previewUrl} alt={image.title} />
                  </li>
                ))}
              </ul>
            </section>

            <section>
              <div className="storyboards-brief-detail-heading">
                <span className="storyboards-brief-detail-index" aria-hidden="true">
                  07
                </span>
                <strong>
                  参考视频 <small>VIDEO · {creativeInput.referenceVideos.length} 条</small>
                </strong>
              </div>
              <ul className="storyboards-brief-reference-videos" aria-label="参考视频">
                {creativeInput.referenceVideos.map((video) => (
                  <li key={video.id} aria-label={video.title}>
                    <button
                      aria-label={`双击查看${video.title}`}
                      className="storyboards-brief-reference-video"
                      data-video-preview-trigger
                      onDoubleClick={() => openPreview(createVideoPreviewItem(video))}
                      onKeyDown={(event) => handleVideoPreviewKeyDown(event, video)}
                      title="双击查看视频"
                      type="button"
                    >
                      <MediaThumbnailSurface
                        className="storyboards-brief-reference-video-cover"
                        fileName={video.title}
                        mediaType="video"
                        url={video.previewUrl}
                      />
                    </button>
                    {video.duration ? <time>{video.duration}</time> : null}
                  </li>
                ))}
              </ul>
            </section>
          </div>
        </section>

        <div className="storyboards-brief-actions">
          <label className="storyboards-brief-confirm" data-confirmed={confirmed || undefined}>
            <input
              type="checkbox"
              aria-label="确认创作 Brief 内容无误"
              checked={confirmed}
              onChange={(event) => {
                if (event.target.checked && storyboard.status === 'draft') onConfirm()
              }}
            />
            <span className="storyboards-brief-checkbox" aria-hidden="true">
              {confirmed ? <Check size={11} strokeWidth={3} /> : null}
            </span>
            <span>{confirmed ? '创作 Brief 已确认' : '我已确认创作 Brief 内容无误'}</span>
            {confirmed && storyboard.confirmedAt ? <time>{storyboard.confirmedAt}</time> : null}
          </label>

          {submitted ? (
            <button
              ref={editButtonRef}
              type="button"
              aria-label={
                hasRunRecord ? `查看 ${storyboard.title} 的 Agent 运行状态` : '创作任务已提交'
              }
              className="storyboards-brief-submit"
              data-status="submitted"
              disabled={!hasRunRecord}
              onClick={onOpenRunRecord}
            >
              {runLive
                ? '已提交 · Agent 运行中'
                : hasRunRecord
                  ? '已提交 · 查看生成结果'
                  : '已提交'}
            </button>
          ) : (
            <button
              type="button"
              className="storyboards-brief-submit"
              disabled={!confirmed}
              onClick={onSubmit}
            >
              {!confirmed ? <LockKeyhole size={12} aria-hidden="true" /> : null}
              {agentRun?.phase === 'failed' ? '重新提交创作任务' : '提交创作任务'}
            </button>
          )}

          <p className="storyboards-brief-action-hint">
            {getBriefActionHint(storyboard.status, agentRun)}
          </p>

          {storyboard.status === 'draft' ? (
            <button
              type="button"
              className="storyboards-brief-edit"
              onClick={() => setEditing(true)}
            >
              <Pencil size={11} aria-hidden="true" />
              修改 Brief / 素材
            </button>
          ) : null}
        </div>

        {editing ? (
          <form
            className="storyboards-brief-editor"
            aria-labelledby="storyboards-brief-editor-title"
            aria-modal="true"
            role="dialog"
            onKeyDown={(event) => {
              if (event.key !== 'Escape') return
              event.preventDefault()
              closeEditor()
            }}
            onSubmit={(event) => {
              event.preventDefault()
              onSave(editableBrief)
              setEditing(false)
            }}
          >
            <div className="storyboards-brief-editor-heading">
              <strong id="storyboards-brief-editor-title">修改创作 Brief</strong>
              <span>保存后可重新确认</span>
            </div>
            <div className="storyboards-brief-editor-fields">
              {EDITABLE_BRIEF_FIELDS.map((field, index) => (
                <label key={field.key}>
                  <span>{field.label}</span>
                  <textarea
                    autoFocus={index === 0}
                    aria-label={field.label}
                    rows={2}
                    value={editableBrief[field.key]}
                    onChange={(event) =>
                      setEditableBrief((current) => ({
                        ...current,
                        [field.key]: event.target.value,
                      }))
                    }
                  />
                </label>
              ))}
            </div>
            <div className="storyboards-brief-editor-actions">
              <button type="button" onClick={closeEditor}>
                取消
              </button>
              <button type="submit">保存 Brief</button>
            </div>
          </form>
        ) : null}
      </aside>

      {preview ? (
        <MediaPreviewDialog
          key={`${preview.mediaType}:${preview.attachmentId ?? preview.url}`}
          onClose={closePreview}
          preview={preview}
        />
      ) : null}
    </>
  )
}
