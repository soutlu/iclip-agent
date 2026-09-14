import { useState } from 'react'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'
import { phaseOfStatus } from '../shots'
import type { StripEntry } from './edit-history'

type EditTaskPreviewProps = {
  entry: Extract<StripEntry, { kind: 'pending' | 'failed' }>
  baseUrl: string
  disabled: boolean
  onReturnToCurrent: () => void
}

/** 未产出图片的任务以提交时的底图衬托状态；原始错误仅在详情中展示。 */
export function EditTaskPreview({
  entry,
  baseUrl,
  disabled,
  onReturnToCurrent,
}: EditTaskPreviewProps) {
  const [imageFailed, setImageFailed] = useState(false)
  const failed = entry.kind === 'failed'
  const queued = phaseOfStatus(entry.job.status) === 'queued'
  const errorMessage = entry.job.errorMessage?.trim()

  return (
    <div className="image-edit-task-preview">
      {imageFailed ? (
        <p className="image-edit-source-unavailable">底图暂时无法显示</p>
      ) : (
        <img
          alt="本次编辑底图"
          className="image-edit-task-source"
          src={baseUrl}
          onError={() => setImageFailed(true)}
        />
      )}
      <span className="image-edit-source-label">编辑底图</span>
      <div className="image-edit-task-overlay">
        <div className="image-edit-task-status">
          <div role={failed ? 'alert' : 'status'}>
            <Icon
              className={cn(
                'image-edit-task-icon',
                failed ? 'text-error' : 'text-primary',
                !failed && !queued && 'motion-safe:animate-spin',
              )}
              decorative
              name={failed ? 'alert' : queued ? 'duration' : 'loading'}
            />
            <h3 className="mt-4 text-title font-medium">
              {failed ? '这次没有生成成功' : queued ? '图片正在排队' : '正在生成图片'}
            </h3>
            <p className="mt-2 text-body-sm text-on-surface-muted">
              {failed ? '可以查看失败原因，调整后再试' : '关掉窗口也会继续生成'}
            </p>
          </div>
          {failed ? (
            <div className="image-edit-task-actions">
              <Button disabled={disabled} onClick={onReturnToCurrent} size="md" variant="ghost">
                返回当前帧
              </Button>
              {errorMessage ? (
                <details className="image-edit-error-details">
                  <summary className="ui-focus">
                    查看详情
                    <Icon decorative name="expand" size="sm" />
                  </summary>
                  <p className="image-edit-error-message">{errorMessage}</p>
                </details>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
