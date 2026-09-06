import { cn } from '@/shared/lib/utils'
import { Select } from '@/shared/ui/field'
import { VIDEO_MODELS, type VideoGenerationOptions } from '../video-generation-options'

type VideoGenerationControlsProps = {
  value: VideoGenerationOptions
  onChange: (value: VideoGenerationOptions) => void
  disabled?: boolean
}

export function VideoGenerationControls({
  disabled = false,
  onChange,
  value,
}: VideoGenerationControlsProps) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <Select
        aria-label="视频模型"
        className="h-(--control-height-md) w-auto rounded-xs px-2 text-body-sm"
        disabled={disabled}
        onChange={(event) => onChange({ ...value, model: event.target.value })}
        value={value.model}
      >
        {VIDEO_MODELS.map((model) => (
          <option key={model.value} value={model.value}>
            {model.label}
          </option>
        ))}
      </Select>
      <button
        aria-checked={value.generateAudio}
        aria-label="生成音频"
        className="inline-flex h-(--control-height-md) ui-state cursor-pointer items-center gap-1.5 rounded-xs px-1 text-body-sm text-on-surface ui-focus"
        disabled={disabled}
        onClick={() => onChange({ ...value, generateAudio: !value.generateAudio })}
        role="switch"
        type="button"
      >
        <span>音频</span>
        <span
          aria-hidden="true"
          className={cn(
            'flex h-4 w-7 items-center rounded-full p-0.5 ui-motion-s',
            value.generateAudio ? 'bg-primary' : 'bg-outline',
          )}
        >
          <span
            className={cn(
              'size-3 rounded-full bg-on-primary ui-motion-s',
              value.generateAudio && 'translate-x-3',
            )}
          />
        </span>
      </button>
    </div>
  )
}
