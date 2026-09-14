import { Icon } from '@/shared/icons'
import { IconButton } from '@/shared/ui/button'
import { Select } from '@/shared/ui/field'
import { MenuRadioGroup, MenuRadioItem, MenuRoot, MenuSurface, MenuTrigger } from '@/shared/ui/menu'
import type {
  ImageChannel,
  ImageModel,
  ImageResolution,
  ResolvedImageOptions,
} from './image-edit.api'

type EditGenerationSettingsProps = {
  models: readonly ImageModel[]
  options: ResolvedImageOptions
  aspectRatio: string
  disabled: boolean
  onModelChange: (value: string) => void
  onChannelChange: (value: ImageChannel) => void
  onResolutionChange: (value: ImageResolution) => void
}

/** 常用选项就地选择，渠道收在菜单中；选项收敛仍由 image-edit.api 统一处理。 */
export function EditGenerationSettings({
  models,
  options: { model, resolution, channel, aspectUnsupported },
  aspectRatio,
  disabled,
  onModelChange,
  onChannelChange,
  onResolutionChange,
}: EditGenerationSettingsProps) {
  if (aspectUnsupported) {
    return (
      <p role="alert" className="text-body-sm text-error">
        暂无模型支持 {aspectRatio}，请先调整分镜画幅
      </p>
    )
  }

  return (
    <div className="image-edit-settings">
      <div className="image-edit-settings-controls">
        <span className="image-edit-model-option">
          <Select
            aria-label="图片模型"
            className="image-edit-option"
            disabled={disabled || models.length === 0}
            value={model?.model ?? ''}
            onChange={(event) => onModelChange(event.target.value)}
          >
            {models.length === 0 ? <option value="">读取模型中…</option> : null}
            {models.map((item) => {
              const usable = item.aspectRatios.includes(aspectRatio)
              return (
                <option key={item.model} value={item.model} disabled={!usable}>
                  {usable ? item.label : `${item.label}（不支持 ${aspectRatio}）`}
                </option>
              )
            })}
          </Select>
          <Icon className="image-edit-option-chevron" decorative name="expand" size="sm" />
        </span>
        <span className="image-edit-resolution-option">
          <Select
            aria-label="图片分辨率"
            className="image-edit-option"
            disabled={disabled || resolution === undefined}
            value={resolution ?? ''}
            onChange={(event) => onResolutionChange(event.target.value as ImageResolution)}
          >
            {model?.resolutions.map((value) => (
              <option key={value} value={value}>
                {value.toUpperCase()}
              </option>
            ))}
          </Select>
          <Icon className="image-edit-option-chevron" decorative name="expand" size="sm" />
        </span>
        {channel !== undefined ? (
          <MenuRoot>
            <MenuTrigger asChild>
              <IconButton disabled={disabled} label="更多生成设置" name="settings" size="md" />
            </MenuTrigger>
            <MenuSurface align="end" aria-label="生成设置">
              <p className="px-2 py-1 text-caption text-on-surface-muted">生成渠道</p>
              <MenuRadioGroup
                aria-label="图片生成渠道"
                value={channel}
                onValueChange={(value) => onChannelChange(value as ImageChannel)}
              >
                {model?.channels.map((value) => (
                  <MenuRadioItem key={value} value={value} disabled={disabled}>
                    {value}
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuSurface>
          </MenuRoot>
        ) : null}
      </div>
      <p className="text-caption text-on-surface-muted">
        <span title="画幅跟随分镜">{aspectRatio}</span>
        {channel === undefined ? null : <span> · {channel}</span>}
      </p>
    </div>
  )
}
