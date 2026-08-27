import { type KeyboardEvent, type ReactNode, useState } from 'react'
import type {
  VideoTask,
  VideoTaskAsset,
  VideoTaskSnapshot,
} from '@/features/tasks/video-task.types'
import { Icon } from '@/shared/icons'
import { formatDateTime } from '@/shared/lib/datetime'
import { MediaPreviewDialog, type MediaPreviewItem, useMediaPreview } from '@/shared/ui/media'
import {
  assetPreviewFileName,
  briefDisplayValue,
  handlePreviewKeyDown,
  parseRequirementLines,
} from './task-display'
import TaskRequirementEditor from './task-requirement-editor'
import { type TaskConfirmationDraft, useTaskConfirmationDraft } from './use-task-confirmation-draft'

const TASK_STATUS_LABELS: Record<VideoTask['status'], string> = {
  confirmed: 'Confirmed',
  draft: 'Draft',
  published: 'Published',
  withdrawn: 'Withdrawn',
}

const CONFIRMATION_RATIO_OPTIONS = ['9:16', '16:9', '3:4', '1:1'] as const

const BRIEF_DETAIL_FIELDS: ReadonlyArray<{
  key:
    | 'audience'
    | 'color'
    | 'contentType'
    | 'department'
    | 'platform'
    | 'purpose'
    | 'ratio'
    | 'requester'
    | 'scene'
    | 'selling'
    | 'theme'
    | 'videoType'
  label: string
}> = [
  { key: 'theme', label: '主题' },
  { key: 'purpose', label: '目的' },
  { key: 'audience', label: '目标受众' },
  { key: 'selling', label: '商业卖点' },
  { key: 'scene', label: '使用场景' },
  { key: 'videoType', label: '视频类型' },
  { key: 'platform', label: '使用平台' },
  { key: 'ratio', label: '比例' },
  { key: 'color', label: 'Color' },
  { key: 'contentType', label: '内容类型' },
  { key: 'department', label: '部门' },
  { key: 'requester', label: '需求人' },
]

type BriefDetailEntry = {
  key: string
  label: string
  tags?: string[]
  value: string
}

/**
 * 需求描述：预置的「标题：内容」行清单解析成标签对齐的网格；
 * 自由改写过的内容回退纯文本渲染。
 */
function RequirementDoc({
  confirmation,
  text,
}: {
  confirmation?: TaskConfirmationDraft
  text: string
}) {
  const descriptionText = confirmation?.requirementDescription ?? text
  const lines = parseRequirementLines(descriptionText)
  const editing = confirmation?.requirementEditing ?? false

  return (
    <section aria-label="需求描述" className="home-task-requirement-doc">
      <header className="home-task-requirement-heading">
        <div>
          <span>Creative brief</span>
          <h4>需求描述</h4>
        </div>
        {confirmation ? (
          <button
            aria-label={editing ? '完成修改需求描述' : '修改需求描述'}
            aria-pressed={editing}
            className="home-task-requirement-edit-button"
            type="button"
            onClick={() => confirmation.setRequirementEditing(!editing)}
          >
            {editing ? '完成' : '修改'}
          </button>
        ) : null}
      </header>
      {editing && confirmation ? (
        <TaskRequirementEditor
          initialText={descriptionText}
          onChange={confirmation.setRequirementDescription}
        />
      ) : descriptionText && lines ? (
        <dl className="home-task-requirement-lines">
          {lines.map((line, index) => (
            <div data-empty={!line.text} key={`${line.label}-${String(index)}`}>
              <dt>{line.label}</dt>
              <dd>{line.text || '未填写'}</dd>
            </div>
          ))}
        </dl>
      ) : descriptionText ? (
        <div className="home-task-requirement-doc-body">{descriptionText}</div>
      ) : null}
    </section>
  )
}

type TaskTableVariant = 'confirm' | 'dispatch'

/** 渲染一个单元格所需的行级上下文。 */
type TaskCellContext = {
  openPreview: (preview: MediaPreviewItem) => void
  referenceImages: readonly VideoTaskAsset[]
  referenceVideos: readonly VideoTaskAsset[]
  task: VideoTask
  videoType: string
}

type TaskTableColumn = {
  /** role="cell" 容器的 className。 */
  className: string
  header: string
  renderCell: (context: TaskCellContext) => ReactNode
}

const IDENTITY_COLUMN: TaskTableColumn = {
  className: 'home-task-identity',
  header: 'Style',
  renderCell: ({ task }) => (
    <>
      {task.style.previewImageUrl ? (
        <img
          alt={`${task.style.styleNo} 产品主图`}
          className="home-task-cover"
          height={74}
          loading="lazy"
          src={task.style.previewImageUrl}
          width={92}
        />
      ) : (
        <span className="home-task-cover home-task-cover--missing">主图不可用</span>
      )}
      <div className="home-task-copy">
        <strong className="home-task-style-id">{task.style.styleNo}</strong>
        <span className="home-task-style-meta">
          {task.style.brand} · {task.style.category}
        </span>
      </div>
    </>
  ),
}

const REQUESTER_COLUMN: TaskTableColumn = {
  className: 'home-task-requester-cell',
  header: '需求方',
  renderCell: ({ task }) => (
    <>
      <strong>{task.brief.requester ? task.brief.requester : '—'}</strong>
      <span>{task.brief.department ? briefDisplayValue(task.brief.department) : '未设置部门'}</span>
    </>
  ),
}

type ReferenceMediaCellProps = {
  assets: readonly VideoTaskAsset[]
  kind: 'image' | 'video'
  onPreview: (preview: MediaPreviewItem) => void
}

/** 确认行里的轻量媒资轨道；与展开材料列表共用等高、自然宽高比的媒体排布。 */
function ReferenceMediaCell({ assets, kind, onPreview }: ReferenceMediaCellProps) {
  const kindLabel = kind === 'image' ? '参考图' : '参考视频'

  if (assets.length === 0) {
    return <span className="home-task-reference-empty">—</span>
  }

  return (
    <div aria-label={`任务${kindLabel}`} className="home-task-reference-list" role="group">
      {assets.map((asset, index) => {
        const itemLabel = `任务${kindLabel} ${String(index + 1)}`
        const preview = () =>
          onPreview({
            altText: kind === 'image' ? itemLabel : undefined,
            fileName: assetPreviewFileName(asset.url, itemLabel),
            mediaType: kind,
            url: asset.url,
          })

        return (
          <button
            aria-label={`双击查看${itemLabel}`}
            className="home-task-reference-trigger"
            key={asset.id}
            title={`双击查看${kindLabel}`}
            type="button"
            onClick={(event) => event.stopPropagation()}
            onDoubleClick={(event) => {
              event.stopPropagation()
              preview()
            }}
            onKeyDown={(event) => handlePreviewKeyDown(event, preview)}
          >
            {kind === 'image' ? (
              <img alt={itemLabel} className="media-natural-ratio" src={asset.url} />
            ) : (
              <video
                aria-label={itemLabel}
                className="media-natural-ratio"
                muted
                playsInline
                preload="metadata"
                src={asset.url}
              />
            )}
          </button>
        )
      })}
    </div>
  )
}

const REFERENCE_IMAGES_COLUMN: TaskTableColumn = {
  className: 'home-task-reference-cell',
  header: '参考图',
  renderCell: ({ openPreview, referenceImages }) => (
    <ReferenceMediaCell assets={referenceImages} kind="image" onPreview={openPreview} />
  ),
}

const REFERENCE_VIDEOS_COLUMN: TaskTableColumn = {
  className: 'home-task-reference-cell',
  header: '参考视频',
  renderCell: ({ openPreview, referenceVideos }) => (
    <ReferenceMediaCell assets={referenceVideos} kind="video" onPreview={openPreview} />
  ),
}

const DEPARTMENT_COLUMN: TaskTableColumn = {
  className: 'home-task-brief-value',
  header: '部门',
  renderCell: ({ task }) =>
    task.brief.department ? briefDisplayValue(task.brief.department) : '未设置',
}

const CONTENT_TYPE_COLUMN: TaskTableColumn = {
  className: 'home-task-brief-value',
  header: '内容类型',
  renderCell: ({ task }) =>
    task.brief.contentType ? briefDisplayValue(task.brief.contentType) : '未设置',
}

const PLATFORM_COLUMN: TaskTableColumn = {
  className: 'home-task-brief-value',
  header: '平台',
  renderCell: ({ task }) =>
    task.brief.platform ? briefDisplayValue(task.brief.platform) : '未设置',
}

const DEADLINE_COLUMN: TaskTableColumn = {
  className: 'home-task-ordered-cell',
  header: '交付时间',
  renderCell: ({ task }) => (task.deadline ? formatDateTime(task.deadline) : '—'),
}

const VIDEO_TYPE_COLUMN: TaskTableColumn = {
  className: 'home-task-brief-value',
  header: '视频类型',
  renderCell: ({ videoType }) => videoType,
}

const ORDERED_AT_COLUMN: TaskTableColumn = {
  className: 'home-task-ordered-cell',
  header: '下单时间',
  renderCell: ({ task }) => (task.createdAt ? formatDateTime(task.createdAt) : '—'),
}

const STATUS_COLUMN: TaskTableColumn = {
  className: 'home-task-status-cell',
  header: '状态',
  renderCell: ({ task }) => (
    <>
      <span className={`home-task-status home-task-status--${task.status}`}>
        {TASK_STATUS_LABELS[task.status]}
      </span>
      <Icon className="home-task-expand-icon" decorative name="expand" size="md" />
    </>
  ),
}

/** 表头与单元格同源的按视角列配置：加列只改这里。 */
const TASK_TABLE_COLUMNS: Record<TaskTableVariant, readonly TaskTableColumn[]> = {
  confirm: [
    IDENTITY_COLUMN,
    REQUESTER_COLUMN,
    REFERENCE_IMAGES_COLUMN,
    REFERENCE_VIDEOS_COLUMN,
    VIDEO_TYPE_COLUMN,
    ORDERED_AT_COLUMN,
    STATUS_COLUMN,
  ],
  dispatch: [
    IDENTITY_COLUMN,
    DEPARTMENT_COLUMN,
    CONTENT_TYPE_COLUMN,
    VIDEO_TYPE_COLUMN,
    PLATFORM_COLUMN,
    DEADLINE_COLUMN,
    STATUS_COLUMN,
  ],
}

type TaskTableProps = {
  emptyMessage: string
  errorMessage?: string
  loading: boolean
  renderActions?: (task: VideoTask) => ReactNode
  /** 详情区的创作材料插槽（确认视角注入编辑器）。 */
  renderMaterials?: (task: VideoTask, confirmation: TaskConfirmationDraft) => ReactNode
  snapshot: VideoTaskSnapshot
  variant: TaskTableVariant
}

/**
 * Task 列表：下发视角展示需求规格与交付时间，确认视角展示需求人与下单时间；行可展开完整 Brief。
 *
 * @param props - 快照数据、视角、加载态与动作插槽。
 * @returns 可展开明细的任务表格。
 */
export default function TaskTable({
  emptyMessage,
  errorMessage,
  loading,
  renderActions,
  renderMaterials,
  snapshot,
  variant,
}: TaskTableProps) {
  const [expandedTaskId, setExpandedTaskId] = useState<null | string>(null)
  const { closePreview, openPreview, preview } = useMediaPreview()

  return (
    <>
      <div className="home-task-table-viewport">
        <div
          aria-label="Creative tasks"
          className={
            variant === 'confirm' ? 'home-task-table home-task-table--confirm' : 'home-task-table'
          }
          role="table"
        >
          <div className="home-task-table-header" role="row">
            {TASK_TABLE_COLUMNS[variant].map((column) => (
              <span key={column.header} role="columnheader">
                {column.header}
              </span>
            ))}
          </div>

          {loading ? <p className="home-task-state">正在加载任务…</p> : null}
          {errorMessage ? (
            <p className="home-task-state home-task-state--error" role="alert">
              {errorMessage}
            </p>
          ) : null}
          {!loading && !errorMessage && snapshot.tasks.length === 0 ? (
            <p className="home-task-state">{emptyMessage}</p>
          ) : null}

          {snapshot.tasks.map((task) => (
            <TaskRow
              assetsById={snapshot.assetsById}
              expanded={expandedTaskId === task.id}
              key={task.id}
              openPreview={openPreview}
              renderActions={renderActions}
              renderMaterials={renderMaterials}
              task={task}
              variant={variant}
              onToggle={() =>
                setExpandedTaskId((current) => (current === task.id ? null : task.id))
              }
            />
          ))}
        </div>
      </div>
      {preview ? <MediaPreviewDialog preview={preview} onClose={closePreview} /> : null}
    </>
  )
}

function TaskRow({
  assetsById,
  expanded,
  openPreview,
  onToggle,
  renderActions,
  renderMaterials,
  task,
  variant,
}: {
  assetsById: Record<string, VideoTaskAsset>
  expanded: boolean
  openPreview: (preview: MediaPreviewItem) => void
  onToggle: () => void
  renderActions?: (task: VideoTask) => ReactNode
  renderMaterials?: (task: VideoTask, confirmation: TaskConfirmationDraft) => ReactNode
  task: VideoTask
  variant: TaskTableVariant
}) {
  const videoType = task.brief.videoType ? briefDisplayValue(task.brief.videoType) : '未设置'
  const referenceImages = task.brief.referenceImages
    .map((assetId) => assetsById[assetId])
    .filter((asset): asset is VideoTaskAsset => asset !== undefined)
  const referenceVideos = task.brief.referenceVideos
    .map((assetId) => assetsById[assetId])
    .filter((asset): asset is VideoTaskAsset => asset !== undefined)
  const detailsId = `home-task-details-${task.id}`

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') {
      return
    }
    event.preventDefault()
    onToggle()
  }

  return (
    <div className="home-task-entry" role="rowgroup">
      <article
        aria-controls={detailsId}
        aria-expanded={expanded}
        className="home-task-row"
        role="row"
        tabIndex={0}
        onClick={onToggle}
        onKeyDown={handleKeyDown}
      >
        {TASK_TABLE_COLUMNS[variant].map((column) => (
          <div className={column.className} key={column.header} role="cell">
            {column.renderCell({
              openPreview,
              referenceImages,
              referenceVideos,
              task,
              videoType,
            })}
          </div>
        ))}
      </article>

      <TaskDetails
        detailsId={detailsId}
        expanded={expanded}
        key={`${task.id}:${task.updatedAt ?? ''}`}
        renderActions={renderActions}
        renderMaterials={renderMaterials}
        task={task}
      />
    </div>
  )
}

function TaskDetails({
  detailsId,
  expanded,
  renderActions,
  renderMaterials,
  task,
}: {
  detailsId: string
  expanded: boolean
  renderActions?: (task: VideoTask) => ReactNode
  renderMaterials?: (task: VideoTask, confirmation: TaskConfirmationDraft) => ReactNode
  task: VideoTask
}) {
  const confirmation = useTaskConfirmationDraft(task)
  const confirmationEnabled = renderMaterials !== undefined
  const briefEntries: BriefDetailEntry[] = [
    ...(task.brief.styleNos && task.brief.styleNos.length > 0
      ? [{ key: 'styleNos', label: 'Style', value: task.brief.styleNos.join('、') }]
      : []),
    ...BRIEF_DETAIL_FIELDS.flatMap((field): BriefDetailEntry[] => {
      const value = task.brief[field.key]
      if (field.key === 'ratio') {
        const ratioEntry =
          confirmationEnabled || (typeof value === 'string' && value.trim())
            ? [
                {
                  key: field.key,
                  label: field.label,
                  value: confirmationEnabled ? confirmation.ratio : String(value),
                },
              ]
            : []
        const durationEntry =
          confirmationEnabled || typeof task.brief.durationSeconds === 'number'
            ? [
                {
                  key: 'durationSeconds',
                  label: '时长',
                  value: confirmationEnabled
                    ? confirmation.durationInput
                    : `${String(task.brief.durationSeconds)} 秒`,
                },
              ]
            : []
        return [...ratioEntry, ...durationEntry]
      }
      return typeof value === 'string' && value.trim()
        ? [
            {
              key: field.key,
              label: field.label,
              // Color 是「、」连接的多选值，详情里还原成标签展示
              tags: field.key === 'color' ? value.split('、').filter(Boolean) : undefined,
              value: briefDisplayValue(value),
            },
          ]
        : []
    }),
    {
      key: 'deadline',
      label: '交付时间',
      value: task.deadline ? formatDateTime(task.deadline) : '—',
    },
    {
      key: 'createdAt',
      label: '下单时间',
      value: task.createdAt ? formatDateTime(task.createdAt) : '—',
    },
  ]

  return (
    <section
      aria-hidden={!expanded}
      aria-label={`任务详情：${task.title}`}
      className="home-task-details"
      data-expanded={expanded}
      id={detailsId}
      inert={!expanded}
      role="row"
    >
      <div className="home-task-details-clip" role="cell">
        <div className="home-task-details-inner">
          <dl className="home-task-details-brief">
            {briefEntries.map((entry, index) => (
              <div key={entry.key}>
                <dt>
                  <span>{String(index + 1).padStart(2, '0')}</span>
                  {entry.label}
                </dt>
                <dd>
                  {confirmationEnabled && entry.key === 'ratio' ? (
                    <select
                      aria-label="比例"
                      className="home-task-detail-input"
                      data-control="ratio"
                      name="confirmationRatio"
                      value={confirmation.ratio}
                      onChange={(event) => confirmation.setRatio(event.currentTarget.value)}
                    >
                      {Array.from(
                        new Set([
                          ...(confirmation.ratio ? [confirmation.ratio] : []),
                          ...CONFIRMATION_RATIO_OPTIONS,
                        ]),
                      ).map((ratio) => (
                        <option key={ratio} value={ratio}>
                          {ratio}
                        </option>
                      ))}
                    </select>
                  ) : confirmationEnabled && entry.key === 'durationSeconds' ? (
                    <span className="home-task-detail-editable">
                      <input
                        aria-label="时长（秒）"
                        className="home-task-detail-input"
                        data-control="duration"
                        max={50}
                        min={3}
                        name="confirmationDuration"
                        step="1"
                        type="number"
                        value={confirmation.durationInput}
                        onChange={(event) =>
                          confirmation.setDurationInput(event.currentTarget.value)
                        }
                      />
                      {confirmation.durationError ? (
                        <span className="home-task-detail-error" role="alert">
                          {confirmation.durationError}
                        </span>
                      ) : null}
                    </span>
                  ) : entry.tags ? (
                    <span className="home-task-detail-tags">
                      {entry.tags.map((tag) => (
                        <span className="home-task-detail-tag" key={tag}>
                          {tag}
                        </span>
                      ))}
                    </span>
                  ) : (
                    entry.value
                  )}
                </dd>
              </div>
            ))}
          </dl>

          {task.brief.requirementDescription ? (
            <RequirementDoc
              confirmation={confirmationEnabled ? confirmation : undefined}
              text={task.brief.requirementDescription}
            />
          ) : confirmationEnabled ? (
            <RequirementDoc confirmation={confirmation} text="" />
          ) : null}

          {renderMaterials && expanded ? renderMaterials(task, confirmation) : null}

          {renderActions ? (
            <div className="home-task-details-actions">{renderActions(task)}</div>
          ) : null}
        </div>
      </div>
    </section>
  )
}
