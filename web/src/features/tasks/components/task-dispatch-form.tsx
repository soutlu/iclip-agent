import { useMutation } from '@tanstack/react-query'
import { X } from 'lucide-react'
import { type FormEvent, type KeyboardEvent, useState } from 'react'
import { getProductInfo } from '@/features/tasks/api/video-task.api'
import type { CreateVideoTaskInput } from '@/features/tasks/video-task.types'
import { useUser } from '@/shared/auth'
import { formatDateTime } from '@/shared/lib/datetime'
import TaskChoiceChips from './task-choice-chips'
import { TaskMediaPicker } from './task-media-picker'
import TaskRequirementEditor from './task-requirement-editor'
import { createTaskRequirementText, resolveTaskRequirementText } from './task-requirement-template'
import { taskMediaAttachmentsToFiles, useTaskMediaAttachments } from './use-task-media-attachments'

/** 支持可增加的初始选项集（用户新增仅在当前会话生效）。 */
const INITIAL_VIDEO_TYPE_OPTIONS = ['品牌视频', '产品视频', '短视频'] as const
const INITIAL_PLATFORM_OPTIONS = ['Amazon', 'DTC', 'Social-TT', 'Social-INS', 'Social-FB'] as const
const INITIAL_RATIO_OPTIONS = ['9:16', '16:9'] as const

/** 已通过 PDM 校验、可下发的 Style 选择。 */
type SelectedStyle = {
  brand: string
  category: string
  /** 该 Style 在 ERP 的最新有效颜色名，作为 Color 候选标签。 */
  colors: string[]
  previewImageUrl: string
  styleNo: string
}

/**
 * 默认交付日 = 本地日期 + 7 天。日期必须按本地字段拼接：`toISOString()` 会先转 UTC，
 * UTC+8 用户在本地 00:00–08:00 打开表单时会少算一天。
 *
 * @returns `yyyy-mm-dd` 形式的本地日期，供 `<input type="date">` 直接使用。
 */
const createDefaultDeadline = () => {
  const deadline = new Date()
  deadline.setDate(deadline.getDate() + 7)

  const year = deadline.getFullYear()
  const month = String(deadline.getMonth() + 1).padStart(2, '0')
  const day = String(deadline.getDate()).padStart(2, '0')

  return `${year}-${month}-${day}`
}

type TaskDispatchFormProps = {
  error: Error | null
  onCancel: () => void
  onSubmit: (input: CreateVideoTaskInput) => void
  submitting: boolean
}

/**
 * 下发 Task 表单：选项组支持自定义增加、Style 多选联动品牌品类、
 * 需求描述使用标题预置的自由文档。
 *
 * @param props - 提交回调、提交态与错误。
 * @returns 完整的下发任务表单。
 */
export default function TaskDispatchForm({
  error,
  onCancel,
  onSubmit,
  submitting,
}: TaskDispatchFormProps) {
  const [videoTypeOptions, setVideoTypeOptions] = useState<string[]>([
    ...INITIAL_VIDEO_TYPE_OPTIONS,
  ])
  const [platformOptions, setPlatformOptions] = useState<string[]>([...INITIAL_PLATFORM_OPTIONS])
  const [ratioOptions, setRatioOptions] = useState<string[]>([...INITIAL_RATIO_OPTIONS])
  const [videoType, setVideoType] = useState('短视频')
  const [platform, setPlatform] = useState('Amazon')
  const [ratio, setRatio] = useState('9:16')

  const [styleDraft, setStyleDraft] = useState('')
  const [styles, setStyles] = useState<SelectedStyle[]>([])
  const [colors, setColors] = useState<string[]>([])
  const [customColorOptions, setCustomColorOptions] = useState<string[]>([])
  const [contentType, setContentType] = useState('')
  const [deadline, setDeadline] = useState(createDefaultDeadline)
  const [requirementDescription, setRequirementDescription] = useState(createTaskRequirementText)
  const [orderedAt] = useState(() => new Date())
  const referenceVideos = useTaskMediaAttachments('video')
  const { data: user } = useUser()
  // 需求人直接关联当前登录用户，不再手填；SSO 自动建号的用户没有 username，优先 displayName。
  const requester = user?.displayName || user?.username || ''
  // PMS 部门数组保持服务端顺序；Task 将全部有效名称去重后冻结为一个可读字段。
  const department = Array.from(
    new Set((user?.departments ?? []).map(({ name }) => name.trim()).filter(Boolean)),
  ).join('、')

  const addStyleMutation = useMutation({
    mutationFn: (styleNo: string) => getProductInfo(styleNo),
    onSuccess: (product) => {
      setStyles((current) =>
        current.some((style) => style.styleNo === product.styleNo)
          ? current
          : [
              ...current,
              {
                brand: product.brand,
                category: product.category,
                colors: product.colors.map((item) => item.name),
                previewImageUrl: product.images[0]?.url ?? '',
                styleNo: product.styleNo,
              },
            ],
      )
      setStyleDraft('')
    },
  })

  const primaryStyle = styles[0]
  const colorOptions = Array.from(
    new Set([...styles.flatMap((style) => style.colors), ...customColorOptions]),
  )

  const addStyle = () => {
    const styleNo = styleDraft.trim()
    if (!styleNo || addStyleMutation.isPending) {
      return
    }
    if (styles.some((style) => style.styleNo === styleNo)) {
      setStyleDraft('')
      return
    }
    addStyleMutation.mutate(styleNo)
  }

  const handleStyleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing) {
      return
    }
    event.preventDefault()
    addStyle()
  }

  const removeStyle = (styleNo: string) => {
    const next = styles.filter((style) => style.styleNo !== styleNo)
    const remainingOptions = new Set([
      ...next.flatMap((style) => style.colors),
      ...customColorOptions,
    ])
    setStyles(next)
    setColors((selected) => selected.filter((value) => remainingOptions.has(value)))
  }

  const canSubmit =
    styles.length > 0 && Boolean(deadline) && !submitting && referenceVideos.pendingCount === 0

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!primaryStyle || !canSubmit) {
      return
    }

    onSubmit({
      brief: {
        color: colors.join('、'),
        contentType,
        department,
        platform,
        ratio,
        requester,
        requirementDescription: resolveTaskRequirementText(requirementDescription),
        styleNos: styles.map((style) => style.styleNo),
        videoType,
      },
      deadline,
      referenceImages: [],
      referenceVideos: taskMediaAttachmentsToFiles(referenceVideos.attachments),
      styleNo: primaryStyle.styleNo,
    })
  }

  return (
    <form className="home-task-composer" aria-label="下发任务" onSubmit={handleSubmit}>
      <div className="home-task-composer-title">
        <h2>下发任务</h2>
        <p>Style 与交付时间为必填，其余按需填写</p>
      </div>

      <div className="home-task-composer-grid">
        <div className="home-task-composer-main">
          <section aria-labelledby="home-task-style-title" className="home-task-form-section">
            <div className="home-task-section-heading">
              <h3 id="home-task-style-title">
                Style <b aria-hidden="true">*</b>
              </h3>
              <span>第一条为主 Style，自动关联品牌与品类</span>
            </div>
            <div className="home-task-style-picker">
              <input
                autoComplete="off"
                name="styleNo"
                placeholder="输入产品 Style 号后回车添加，可多选"
                value={styleDraft}
                onChange={(event) => setStyleDraft(event.currentTarget.value)}
                onKeyDown={handleStyleKeyDown}
              />
              <button
                className="home-task-style-add"
                disabled={!styleDraft.trim() || addStyleMutation.isPending}
                type="button"
                onClick={addStyle}
              >
                {addStyleMutation.isPending ? '校验中…' : '添加'}
              </button>
            </div>
            {addStyleMutation.error ? (
              <p className="home-task-media-error" role="alert">
                {addStyleMutation.error.message}
              </p>
            ) : null}
            {styles.length > 0 ? (
              <ul aria-label="已选 Style" className="home-task-style-chips">
                {styles.map((style) => (
                  <li className="home-task-style-chip" key={style.styleNo}>
                    <strong>{style.styleNo}</strong>
                    <span>
                      {style.brand} · {style.category}
                    </span>
                    <button
                      aria-label={`移除 Style ${style.styleNo}`}
                      type="button"
                      onClick={() => removeStyle(style.styleNo)}
                    >
                      <X aria-hidden="true" size={11} strokeWidth={2} />
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </section>

          <section
            aria-labelledby="home-task-choices-title"
            className="home-task-form-section home-task-choice-section"
          >
            <div className="home-task-section-heading">
              <h3 id="home-task-choices-title">视频规格</h3>
            </div>
            <div className="home-task-choice-rows">
              <div className="home-task-choice-row">
                <span className="home-task-key-element-label">视频类型</span>
                <TaskChoiceChips
                  label="视频类型"
                  name="videoType"
                  options={videoTypeOptions}
                  value={videoType}
                  onAddOption={(option) => setVideoTypeOptions((current) => [...current, option])}
                  onValueChange={setVideoType}
                />
              </div>
              <div className="home-task-choice-row">
                <span className="home-task-key-element-label">使用平台</span>
                <TaskChoiceChips
                  label="视频使用平台"
                  name="platform"
                  options={platformOptions}
                  value={platform}
                  onAddOption={(option) => setPlatformOptions((current) => [...current, option])}
                  onValueChange={setPlatform}
                />
              </div>
              <div className="home-task-choice-row">
                <span className="home-task-key-element-label">视频尺寸</span>
                <TaskChoiceChips
                  label="视频尺寸"
                  name="ratio"
                  options={ratioOptions}
                  value={ratio}
                  onAddOption={(option) => setRatioOptions((current) => [...current, option])}
                  onValueChange={setRatio}
                />
              </div>
            </div>
          </section>

          <section
            aria-labelledby="home-task-brief-info-title"
            className="home-task-form-section home-task-brief-info"
          >
            <div className="home-task-section-heading">
              <h3 id="home-task-brief-info-title">需求简报</h3>
            </div>
            <div className="home-task-brief-info-grid">
              <div className="home-task-field home-task-field--full">
                <span>Color</span>
                <TaskChoiceChips
                  label="Color"
                  multiple
                  name="color"
                  options={colorOptions}
                  values={colors}
                  onAddOption={(option) => setCustomColorOptions((current) => [...current, option])}
                  onValuesChange={setColors}
                />
              </div>
              <label className="home-task-field">
                <span>内容类型</span>
                <input
                  name="contentType"
                  placeholder="穿搭、开箱等（非必填）"
                  value={contentType}
                  onChange={(event) => setContentType(event.currentTarget.value)}
                />
              </label>
              <div className="home-task-field">
                <span>部门</span>
                <output className="home-task-readonly-value" name="department">
                  {department || '—'}
                </output>
              </div>
              <div className="home-task-field">
                <span>需求人</span>
                <output className="home-task-readonly-value" name="requester">
                  {requester || '—'}
                </output>
              </div>
              <label className="home-task-field">
                <span>
                  交付时间 <b aria-hidden="true">*</b>
                </span>
                <input
                  name="deadline"
                  required
                  type="date"
                  value={deadline}
                  onChange={(event) => setDeadline(event.currentTarget.value)}
                />
              </label>
              <div className="home-task-field">
                <span>下单时间</span>
                <output className="home-task-readonly-value" name="orderedAt">
                  {formatDateTime(orderedAt)}
                </output>
              </div>
            </div>
          </section>
        </div>

        <div className="home-task-overview-column">
          {primaryStyle ? (
            <section className="home-task-product-info" aria-labelledby="home-task-product-title">
              <div className="home-task-product-heading">
                <span className="home-task-product-title">
                  <h3 id="home-task-product-title">主 Style</h3>
                </span>
                <span className="home-task-product-status">已同步</span>
              </div>
              <div
                className={
                  primaryStyle.previewImageUrl
                    ? 'home-task-product-content'
                    : 'home-task-product-content home-task-product-content--without-image'
                }
              >
                {primaryStyle.previewImageUrl ? (
                  <img
                    alt={`${primaryStyle.styleNo} 产品主图`}
                    className="home-task-product-image media-natural-ratio"
                    src={primaryStyle.previewImageUrl}
                  />
                ) : null}
                <div className="home-task-product-copy">
                  <div className="home-task-product-style">
                    <strong>{primaryStyle.styleNo}</strong>
                  </div>
                  <dl className="home-task-product-details">
                    <div>
                      <dt>品牌</dt>
                      <dd>{primaryStyle.brand}</dd>
                    </div>
                    <div>
                      <dt>品类</dt>
                      <dd>{primaryStyle.category}</dd>
                    </div>
                  </dl>
                </div>
              </div>
            </section>
          ) : null}

          <section
            aria-labelledby="home-task-requirement-title"
            className="home-task-form-section home-task-requirement-fields"
          >
            <div className="home-task-section-heading">
              <h3 id="home-task-requirement-title">需求描述</h3>
            </div>
            <TaskRequirementEditor onChange={setRequirementDescription} />
          </section>

          <div className="home-task-form-section home-task-media-sections">
            <TaskMediaPicker
              attachments={referenceVideos.attachments}
              errorMessage={referenceVideos.errorMessage}
              kind="video"
              label="Ref Vid（非必填）"
              pendingCount={referenceVideos.pendingCount}
              onFilesSelected={referenceVideos.ingest}
              onRemove={referenceVideos.remove}
            />
          </div>
        </div>
      </div>

      {error ? (
        <p className="home-task-submit-error" role="alert">
          {error.message}
        </p>
      ) : null}

      <div className="home-task-composer-actions">
        <button disabled={submitting} type="button" onClick={onCancel}>
          取消
        </button>
        <button className="home-task-submit" disabled={!canSubmit} type="submit">
          {submitting ? '正在下发…' : '下发任务'}
        </button>
      </div>
    </form>
  )
}
