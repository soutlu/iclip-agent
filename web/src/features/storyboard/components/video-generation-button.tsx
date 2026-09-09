/** 出片入口：左半边选模型，右半边提交。模型只有 id，允许表由服务端配置给出。 */

import { Icon } from '@/shared/icons'
import { Button } from '@/shared/ui/button'
import { MenuRadioGroup, MenuRadioItem, MenuRoot, MenuSurface, MenuTrigger } from '@/shared/ui/menu'

type VideoGenerationButtonProps = {
  models: readonly string[]
  model: string | undefined
  /** 模型清单读不到时给用户看的原因；还在读就不传。 */
  unavailable?: string | undefined
  onChangeModel: (model: string) => void
  onGenerate: () => void
  submitting: boolean
}

export function VideoGenerationButton({
  model,
  models,
  onChangeModel,
  onGenerate,
  submitting,
  unavailable,
}: VideoGenerationButtonProps) {
  return (
    <div className="inline-flex shrink-0 items-stretch">
      <MenuRoot>
        <MenuTrigger
          aria-label={model === undefined ? '视频模型' : `视频模型：${model}`}
          className="inline-flex h-(--control-height-md) ui-state cursor-pointer items-center gap-1 rounded-l-sm border-[0.5px] border-r-0 border-chat-hairline bg-background px-3 text-body-sm text-on-surface ui-focus disabled:cursor-default disabled:opacity-50"
          disabled={model === undefined || submitting}
        >
          <span className="max-w-40 truncate">{model ?? unavailable ?? '读取模型…'}</span>
          <Icon className="text-on-surface-variant" decorative name="expand" size="sm" />
        </MenuTrigger>
        <MenuSurface align="end">
          {/* 没有模型时触发键是禁用的，菜单打不开；这里只是不给单选组塞 undefined。 */}
          <MenuRadioGroup
            onValueChange={onChangeModel}
            {...(model === undefined ? {} : { value: model })}
          >
            {models.map((item) => (
              <MenuRadioItem key={item} value={item}>
                {item}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuSurface>
      </MenuRoot>
      <Button
        className="rounded-l-none px-3 shadow-none"
        disabled={model === undefined}
        leadingIcon="video"
        loading={submitting}
        onClick={onGenerate}
        size="md"
      >
        生成视频
      </Button>
    </div>
  )
}
