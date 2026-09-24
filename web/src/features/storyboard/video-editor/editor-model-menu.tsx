import { Icon } from '@/shared/icons'
import { MenuRadioGroup, MenuRadioItem, MenuRoot, MenuSurface, MenuTrigger } from '@/shared/ui/menu'

type Props = {
  model: string | undefined
  models: readonly string[]
  disabled: boolean
  onChange: (model: string) => void
}

/** 编辑模型的选择菜单；只列前端认得怎么触发编辑的那几个。触发器是带专属样式的裸按钮，CSS 按它的类名摆。 */
export function EditorModelMenu({ model, models, disabled, onChange }: Props) {
  return (
    <MenuRoot>
      <MenuTrigger asChild>
        <button
          aria-label="编辑模型"
          className="video-editor-model ui-focus"
          disabled={disabled || models.length === 0}
          title={model}
          type="button"
        >
          <span>{model ?? '没有支持编辑的模型'}</span>
          <Icon decorative name="expand" size="sm" />
        </button>
      </MenuTrigger>
      <MenuSurface
        align="start"
        aria-label="编辑模型"
        aria-labelledby={undefined}
        className="video-editor-model-menu"
        collisionPadding={16}
        side="top"
        sideOffset={8}
      >
        <MenuRadioGroup onValueChange={onChange} value={model ?? ''}>
          {models.map((item) => (
            <MenuRadioItem key={item} value={item}>
              {item}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuSurface>
    </MenuRoot>
  )
}
