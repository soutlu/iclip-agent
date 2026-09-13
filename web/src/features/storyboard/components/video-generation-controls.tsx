import { RadioGroup, Switch } from 'radix-ui'
import { Icon } from '@/shared/icons'
import type { VideoGenerationOptions } from '../video-generation-options'

type VideoGenerationControlsProps = {
  models: readonly string[]
  value: VideoGenerationOptions
  onChange: (value: VideoGenerationOptions) => void
}

export function VideoGenerationControls({ models, onChange, value }: VideoGenerationControlsProps) {
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <p className="text-body text-on-surface-variant">模型</p>
        <RadioGroup.Root
          aria-label="视频模型"
          className="flex rounded-xs border-[0.5px] border-chat-hairline"
          onValueChange={(model) => onChange({ ...value, model })}
          orientation="horizontal"
          {...(value.model === undefined ? {} : { value: value.model })}
        >
          {models.map((model) => (
            <RadioGroup.Item
              className="flex h-(--control-height-sm) min-w-0 flex-1 ui-state cursor-pointer items-center justify-center gap-1 rounded-xs border border-transparent px-2 text-body whitespace-nowrap text-on-surface ui-focus data-[state=checked]:border-primary/20 data-[state=checked]:bg-state-active data-[state=checked]:text-primary"
              key={model}
              value={model}
            >
              {model}
              <RadioGroup.Indicator asChild>
                <Icon decorative name="check" size="xs" />
              </RadioGroup.Indicator>
            </RadioGroup.Item>
          ))}
        </RadioGroup.Root>
      </div>
      <div className="flex items-center justify-between gap-4 border-t-[0.5px] border-chat-hairline pt-4">
        <span className="text-body text-on-surface">生成音频</span>
        <div className="flex items-center gap-2 text-on-surface-faint">
          <Icon decorative name={value.generateAudio ? 'audio' : 'audio-off'} size="sm" />
          <span className="text-body-sm">{value.generateAudio ? '已开启' : '已关闭'}</span>
          <Switch.Root
            aria-label="生成音频"
            checked={value.generateAudio}
            className="flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full bg-outline p-0.5 ui-focus ui-motion-s data-[state=checked]:bg-primary"
            onCheckedChange={(generateAudio) => onChange({ ...value, generateAudio })}
          >
            <Switch.Thumb className="size-4 rounded-full bg-on-primary ui-motion-s data-[state=checked]:translate-x-4" />
          </Switch.Root>
        </div>
      </div>
    </div>
  )
}
