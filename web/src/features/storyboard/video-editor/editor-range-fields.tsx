import { Icon } from '@/shared/icons'
import { roundSeconds } from './time-label'
import type { TimeRange } from './time-range'

type Props = {
  range: TimeRange | undefined
  duration: number | undefined
  disabled: boolean
  onChange: (boundary: keyof TimeRange, value: number) => void
}

/** 选段的起止秒数输入；没读到时长时两格都灰着。 */
export function EditorRangeFields({ range, duration, disabled, onChange }: Props) {
  const locked = range === undefined || disabled
  return (
    <div className="video-editor-range">
      <Icon decorative name="duration" size="sm" />
      <label className="sr-only" htmlFor="video-range-start">
        开始时间（秒）
      </label>
      <input
        disabled={locked}
        id="video-range-start"
        max={duration}
        min={0}
        onChange={(event) => onChange('start', event.currentTarget.valueAsNumber)}
        step={0.1}
        type="number"
        value={range?.start ?? ''}
      />
      <Icon decorative name="next" size="sm" />
      <label className="sr-only" htmlFor="video-range-end">
        结束时间（秒）
      </label>
      <input
        disabled={locked}
        id="video-range-end"
        max={duration}
        min={0}
        onChange={(event) => onChange('end', event.currentTarget.valueAsNumber)}
        step={0.1}
        type="number"
        value={range?.end ?? ''}
      />
      <span>{range === undefined ? '' : `${roundSeconds(range.end - range.start)}s`}</span>
    </div>
  )
}
