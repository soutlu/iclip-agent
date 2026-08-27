import { type KeyboardEvent, useEffect, useRef, useState } from 'react'
import { AssistChip, ChipGroup, FilterChip } from '@/shared/ui/chip'

type TaskChoiceChipsBaseProps = {
  label: string
  name: string
  onAddOption: (option: string) => void
  options: readonly string[]
}

type TaskChoiceChipsProps = TaskChoiceChipsBaseProps &
  (
    | {
        /** 多选模式（Color）：chip 可切换、自定义提交时追加选中。 */
        multiple: true
        onValuesChange: (values: string[]) => void
        values: string[]
      }
    | {
        /** 单选模式（视频类型 / 使用平台 / 尺寸）：chip 即选即换。 */
        multiple?: false
        onValueChange: (value: string) => void
        value: string
      }
  )

/**
 * 支持随时增加自定义选项的 chip 组，视觉复用 Inspiration 子类别的 filter chip 设计。
 * 选中语义与键盘遍历交给 Radix ToggleGroup（单选 radiogroup / 多选 toolbar +
 * roving tabindex）；末尾的「自定义」新增入口不属于 ToggleGroup，留在组内并列渲染。
 *
 * @param props - 字段标签、选项集、当前值（单选 value / 多选 values）与新增回调。
 * @returns 一行可选 chip，末尾带内联的“自定义”新增入口。
 */
export default function TaskChoiceChips(props: TaskChoiceChipsProps) {
  const { label, name, onAddOption, options } = props
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState('')
  const addButtonRef = useRef<HTMLButtonElement | null>(null)
  // 键盘提交 / 取消后输入框卸载，焦点会掉到 body；标记一次性还给「自定义」按钮。
  const shouldRestoreFocusRef = useRef(false)

  useEffect(() => {
    if (!adding && shouldRestoreFocusRef.current) {
      shouldRestoreFocusRef.current = false
      addButtonRef.current?.focus()
    }
  }, [adding])

  const commitDraft = () => {
    const option = draft.trim()
    setDraft('')
    setAdding(false)
    if (!option) {
      return
    }
    if (!options.includes(option)) {
      onAddOption(option)
    }
    if (props.multiple) {
      if (!props.values.includes(option)) {
        props.onValuesChange([...props.values, option])
      }
    } else {
      props.onValueChange(option)
    }
  }

  const handleDraftKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) {
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      shouldRestoreFocusRef.current = true
      commitDraft()
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      shouldRestoreFocusRef.current = true
      setDraft('')
      setAdding(false)
    }
  }

  const chips = options.map((option) => (
    <FilterChip key={option} value={option}>
      {option}
    </FilterChip>
  ))

  const addControl = adding ? (
    <input
      aria-label={`新增${label}选项`}
      autoFocus
      className="home-task-choice-input"
      name={`${name}Draft`}
      placeholder="输入后回车"
      value={draft}
      onBlur={commitDraft}
      onChange={(event) => setDraft(event.currentTarget.value)}
      onKeyDown={handleDraftKeyDown}
    />
  ) : (
    <AssistChip
      aria-label={`增加${label}选项`}
      leadingIcon="add"
      ref={addButtonRef}
      onClick={() => setAdding(true)}
    >
      自定义
    </AssistChip>
  )

  return props.multiple ? (
    <ChipGroup
      aria-label={label}
      type="multiple"
      value={props.values}
      onValueChange={props.onValuesChange}
    >
      {chips}
      {addControl}
    </ChipGroup>
  ) : (
    <ChipGroup
      aria-label={label}
      type="single"
      value={props.value}
      onValueChange={(nextValue) => {
        // 单选 chip 不支持取消选中：再点已选项时 Radix 回传空串，忽略即可。
        if (nextValue) {
          props.onValueChange(nextValue)
        }
      }}
    >
      {chips}
      {addControl}
    </ChipGroup>
  )
}
