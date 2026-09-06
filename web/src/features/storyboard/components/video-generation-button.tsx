import { Icon } from '@/shared/icons'
import { Button } from '@/shared/ui/button'
import { PopupAnchor, PopupRoot, PopupSurface, PopupTrigger } from '@/shared/ui/popup'
import { VIDEO_MODELS, type VideoGenerationOptions } from '../video-generation-options'
import { VideoGenerationControls } from './video-generation-controls'

type VideoGenerationButtonProps = {
  value: VideoGenerationOptions
  onChange: (value: VideoGenerationOptions) => void
  onGenerate: () => void
  disabled: boolean
  generating: boolean
}

export function VideoGenerationButton({
  disabled,
  generating,
  onChange,
  onGenerate,
  value,
}: VideoGenerationButtonProps) {
  const modelLabel = VIDEO_MODELS.find((model) => model.value === value.model)?.label ?? value.model
  const audioLabel = value.generateAudio ? '音频开启' : '音频关闭'

  return (
    <PopupRoot>
      <PopupAnchor asChild>
        <div className="inline-flex shrink-0 items-stretch">
          <PopupTrigger asChild>
            <button
              aria-label={`生成设置：${modelLabel}，${audioLabel}`}
              className="group inline-flex h-(--control-height-lg) ui-state cursor-pointer items-center gap-2 rounded-l-sm border-[0.5px] border-r-0 border-chat-hairline bg-chat-card-bg px-3 text-body text-on-surface ui-focus"
              disabled={generating}
              type="button"
            >
              <span>{modelLabel}</span>
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
            className="rounded-l-none rounded-r-sm px-4 shadow-none active:scale-100"
            disabled={disabled}
            leadingIcon="video"
            onClick={onGenerate}
            size="lg"
          >
            {generating ? '正在出片…' : '生成视频'}
          </Button>
        </div>
      </PopupAnchor>
      <PopupSurface
        align="end"
        aria-label="生成设置"
        className="w-70 max-w-[calc(100vw-32px)] space-y-4 border-chat-hairline p-4"
        collisionPadding={16}
        showArrow
        side="top"
        sideOffset={36}
      >
        <h3 className="text-body font-medium text-on-surface-variant">生成设置</h3>
        <VideoGenerationControls onChange={onChange} value={value} />
      </PopupSurface>
    </PopupRoot>
  )
}
