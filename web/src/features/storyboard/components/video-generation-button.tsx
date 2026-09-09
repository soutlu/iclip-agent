import { Icon } from '@/shared/icons'
import { Button } from '@/shared/ui/button'
import { PopupAnchor, PopupRoot, PopupSurface, PopupTrigger } from '@/shared/ui/popup'
import type { VideoGenerationOptions } from '../video-generation-options'
import { VideoGenerationControls } from './video-generation-controls'

type VideoGenerationButtonProps = {
  models: readonly string[]
  value: VideoGenerationOptions
  /** 模型清单读不到时给用户看的原因；还在读就不传。 */
  unavailable?: string | undefined
  onChange: (value: VideoGenerationOptions) => void
  onGenerate: () => void
  disabled: boolean
  submitting: boolean
}

/** 出片入口：左半边是生成设置（模型、音频），右半边提交。放在顶栏，高度跟旁边的按钮一致。 */
export function VideoGenerationButton({
  disabled,
  models,
  submitting,
  onChange,
  onGenerate,
  unavailable,
  value,
}: VideoGenerationButtonProps) {
  // 模型只有 id，没有展示名；清单还没读到时先占个位。
  const modelLabel = value.model ?? unavailable ?? '读取模型…'
  const audioLabel = value.generateAudio ? '音频开启' : '音频关闭'

  return (
    <PopupRoot>
      <PopupAnchor asChild>
        <div className="inline-flex shrink-0 items-stretch">
          <PopupTrigger asChild>
            <button
              aria-label={`生成设置：${modelLabel}，${audioLabel}`}
              className="group inline-flex h-(--control-height-md) ui-state cursor-pointer items-center gap-2 rounded-l-sm border-[0.5px] border-r-0 border-chat-hairline bg-chat-card-bg px-3 text-body text-on-surface ui-focus disabled:cursor-default disabled:opacity-60"
              disabled={submitting || models.length === 0}
              type="button"
            >
              <span className="max-w-44 truncate">{modelLabel}</span>
              <Icon decorative name={value.generateAudio ? 'audio' : 'audio-off'} size="sm" />
              <Icon
                className="ui-motion-s group-data-[state=open]:rotate-180"
                decorative
                name="expand"
                size="xs"
              />
            </button>
          </PopupTrigger>
          <Button
            className="rounded-l-none rounded-r-sm px-3 text-body shadow-none active:scale-100"
            disabled={disabled}
            leadingIcon="video"
            onClick={onGenerate}
            size="md"
          >
            {submitting ? '提交中…' : '生成视频'}
          </Button>
        </div>
      </PopupAnchor>
      <PopupSurface
        align="end"
        aria-label="生成设置"
        // 模型项是完整 id，比短名长，弹层按内容撑宽而不是固定宽度。
        className="w-max max-w-[calc(100vw-32px)] min-w-70 space-y-4 border-chat-hairline p-4"
        collisionPadding={16}
        showArrow
        side="bottom"
        sideOffset={8}
      >
        <h3 className="text-body font-medium text-on-surface-variant">生成设置</h3>
        <VideoGenerationControls models={models} onChange={onChange} value={value} />
      </PopupSurface>
    </PopupRoot>
  )
}
