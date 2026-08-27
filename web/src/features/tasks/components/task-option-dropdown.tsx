import type { SettingsChoiceOption } from '@/shared/composer'
import { Icon } from '@/shared/icons'
import { MenuRadioGroup, MenuRadioItem, MenuRoot, MenuSurface, MenuTrigger } from '@/shared/ui/menu'

type TaskOptionDropdownProps<TValue extends string> = {
  align?: 'bottom-start' | 'top-start'
  label: string
  name: string
  onValueChange: (value: TValue) => void
  options: readonly SettingsChoiceOption<TValue>[]
  value: TValue
}

/**
 * Task 表单与筛选共用的单选下拉，基于 Radix DropdownMenu（非模态）+ RadioGroup：
 * 焦点管理、方向键遍历、打开态 typeahead 与 menu/menuitemradio 语义交给 Radix。
 * 相比强模态 Select：不锁 body 滚动、外部点击一次生效、关闭态不响应 typeahead、
 * value 不在 options 里时触发器仍展示原始值。
 *
 * @param props - 标签、字段名、选项、当前值与变化回调。
 * @returns 展示当前选项并可展开选择的下拉控件。
 */
export default function TaskOptionDropdown<TValue extends string>({
  align = 'bottom-start',
  label,
  name,
  onValueChange,
  options,
  value,
}: TaskOptionDropdownProps<TValue>) {
  const selectedLabel = options.find((option) => option.value === value)?.label ?? value

  return (
    <span className="home-task-key-element-dropdown">
      <MenuRoot modal={false}>
        <MenuTrigger
          aria-label={`${label}，当前：${selectedLabel}`}
          className="home-task-key-element-trigger"
          name={name}
        >
          {selectedLabel}
          <Icon decorative name="expand" size="sm" />
        </MenuTrigger>

        <MenuSurface
          align="start"
          aria-label={label}
          side={align === 'top-start' ? 'top' : 'bottom'}
        >
          <MenuRadioGroup
            value={value}
            onValueChange={(nextValue) => {
              // Radix 回传的是裸 string，按选项表反查回窄类型，避免断言。
              const nextOption = options.find((option) => option.value === nextValue)
              if (nextOption) {
                onValueChange(nextOption.value)
              }
            }}
          >
            {options.map((option) => (
              <MenuRadioItem key={option.value} value={option.value}>
                {option.label}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuSurface>
      </MenuRoot>
    </span>
  )
}
