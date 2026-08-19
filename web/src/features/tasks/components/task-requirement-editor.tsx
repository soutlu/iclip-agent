import Placeholder from '@tiptap/extension-placeholder'
import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { useMemo } from 'react'
import { TaskRequirementHints, taskRequirementHintsKey } from './task-requirement-hints'
import { createTaskRequirementContent } from './task-requirement-template'

type TaskRequirementEditorProps = {
  /** 确认页面传入的已保存纯文本；未传时使用下发模板。 */
  initialText?: string
  /** 文档变化回调：持久化为按段落换行的纯文本。 */
  onChange: (value: string) => void
}

/**
 * 下发 Task 的需求描述编辑器：每行一条 `标题: 内容` 的自由文档，
 * 行尾默认显示灰字填写说明，光标落到该行准备输入时自动消失。
 *
 * @param props - 变化回调。
 * @returns 下发时预置中文需求项、确认时恢复已有纯文本的 Tiptap 编辑器。
 */
export default function TaskRequirementEditor({
  initialText,
  onChange,
}: TaskRequirementEditorProps) {
  const extensions = useMemo(
    () => [
      StarterKit.configure({
        blockquote: false,
        code: false,
        codeBlock: false,
        hardBreak: false,
        heading: false,
        horizontalRule: false,
      }),
      Placeholder.configure({
        placeholder: '例：场景：similar to reference with city street',
      }),
      TaskRequirementHints,
    ],
    [],
  )
  const editor = useEditor({
    content: createTaskRequirementContent(initialText),
    editorProps: {
      attributes: {
        'aria-label': '需求描述',
        role: 'textbox',
      },
    },
    extensions,
    immediatelyRender: false,
    onBlur: ({ editor: current }) => {
      current.view.dispatch(current.state.tr.setMeta(taskRequirementHintsKey, false))
    },
    onFocus: ({ editor: current }) => {
      current.view.dispatch(current.state.tr.setMeta(taskRequirementHintsKey, true))
    },
    onUpdate: ({ editor: current }) => {
      onChange(current.getText({ blockSeparator: '\n' }).trim())
    },
  })

  return (
    <div className="home-task-requirement-editor tiptap-editor">
      <EditorContent editor={editor} />
    </div>
  )
}
