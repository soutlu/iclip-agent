import { fireEvent, screen } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import { renderWithProviders } from '@/testing/render'
import { docToInstructions, instructionsToDoc } from './edit-instruction-doc'
import { EditInstructionEditor } from './edit-instruction-editor'
import type { EditInstruction, EditReference, ImageAnnotation } from './image-edit-types'

const annotations: ImageAnnotation[] = [
  {
    id: 'a-original',
    number: 1,
    kind: 'ellipse',
    points: [
      { x: 0.1, y: 0.2 },
      { x: 0.5, y: 0.7 },
    ],
  },
]
const references: EditReference[] = [
  { id: 'r-original', kind: 'image', label: '原图', url: 'data:image/png,original' },
  { id: 'r-other', kind: 'image', label: '衣服', url: 'data:image/png,other' },
]

function paste(editor: HTMLElement, text: string) {
  fireEvent.paste(editor, {
    clipboardData: { getData: (type: string) => (type === 'text/plain' ? text : '') },
  })
}

describe('编辑要求文档', () => {
  it('往返保留文字空白、换行和引用身份', () => {
    const parts: EditInstruction[] = [
      { kind: 'text', text: '  把' },
      { kind: 'annotation', id: 'a-original' },
      { kind: 'text', text: '\n\n换成 ' },
      { kind: 'referenceImage', id: 'r-other' },
      { kind: 'text', text: ' 的颜色\n  ' },
    ]
    expect(docToInstructions(instructionsToDoc(parts))).toEqual(parts)
    expect(docToInstructions(instructionsToDoc([]))).toEqual([])
  })
})

describe('EditInstructionEditor', () => {
  it('在输入光标插入引用后继续输入，并序列化为业务片段', async () => {
    let changed: EditInstruction[] = []
    await renderWithProviders(
      <EditInstructionEditor
        value={[]}
        onChange={(parts) => {
          changed = parts
        }}
        annotations={annotations}
        references={references}
        onSelectAnnotation={() => {}}
        onPreviewReference={() => {}}
      />,
    )
    const editor = screen.getByRole('textbox', { name: '修改要求' })
    editor.focus()
    paste(editor, '把')
    fireEvent.click(screen.getByRole('button', { name: '插入引用' }))
    fireEvent.click(screen.getByRole('option', { name: '插入标注 1' }))
    paste(editor, '变成蓝色')
    expect(changed).toEqual([
      { kind: 'text', text: '把' },
      { kind: 'annotation', id: 'a-original' },
      { kind: 'text', text: '变成蓝色' },
    ])
  })

  it('中文后输入 @ 可用上下键选择，Enter 替换查询，Esc 关闭', async () => {
    let changed: EditInstruction[] = []
    await renderWithProviders(
      <EditInstructionEditor
        value={[]}
        onChange={(parts) => {
          changed = parts
        }}
        annotations={annotations}
        references={references}
        onSelectAnnotation={() => {}}
        onPreviewReference={() => {}}
      />,
    )
    const editor = screen.getByRole('textbox', { name: '修改要求' })
    editor.focus()
    paste(editor, '参考@')
    expect(screen.getByRole('listbox', { name: '选择引用' })).toBeInTheDocument()
    fireEvent.keyDown(editor, { key: 'ArrowDown' })
    fireEvent.keyDown(editor, { key: 'Enter' })
    expect(changed).toEqual([
      { kind: 'text', text: '参考' },
      { kind: 'referenceImage', id: 'r-original' },
    ])
    fireEvent.click(screen.getByRole('button', { name: '插入引用' }))
    fireEvent.keyDown(editor, { key: 'Escape' })
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('排序仅改变参考图编号；移除后失效，不绑定另一张同编号图片', async () => {
    let picked = ''
    function Example() {
      const [images, setImages] = useState(references)
      return (
        <>
          <EditInstructionEditor
            value={[{ kind: 'referenceImage', id: 'r-original' }]}
            onChange={() => {}}
            annotations={annotations}
            references={images}
            onSelectAnnotation={() => {}}
            onPreviewReference={(id) => {
              picked = id
            }}
          />
          <button
            onClick={() => {
              setImages([...references].reverse())
            }}
          >
            排序
          </button>
          <button
            onClick={() => {
              setImages(references.filter((item) => item.id !== 'r-original'))
            }}
          >
            移除
          </button>
        </>
      )
    }
    await renderWithProviders(<Example />)
    fireEvent.click(screen.getByRole('button', { name: '排序' }))
    const chip = screen.getByRole('button', { name: '参考图 2 · 原图' })
    fireEvent.click(chip)
    expect(picked).toBe('r-original')
    fireEvent.click(screen.getByRole('button', { name: '移除' }))
    expect(screen.getByRole('button', { name: '参考图已失效' })).toHaveAttribute(
      'aria-disabled',
      'true',
    )
    picked = ''
    fireEvent.click(screen.getByRole('button', { name: '参考图已失效' }))
    expect(picked).toBe('')
  })

  it('标注引用支持键盘定位，并在标注删除后保持失效身份', async () => {
    let picked = ''
    function Example() {
      const [items, setItems] = useState(annotations)
      return (
        <>
          <EditInstructionEditor
            value={[{ kind: 'annotation', id: 'a-original' }]}
            onChange={() => {}}
            annotations={items}
            references={references}
            onSelectAnnotation={(id) => {
              picked = id
            }}
            onPreviewReference={() => {}}
          />
          <button
            onClick={() => {
              setItems([{ ...(annotations[0] as ImageAnnotation), id: 'a-replacement' }])
            }}
          >
            重新标注
          </button>
        </>
      )
    }
    await renderWithProviders(<Example />)
    const chip = screen.getByRole('button', { name: '标注 1' })
    fireEvent.keyDown(chip, { key: 'Enter' })
    expect(picked).toBe('a-original')
    fireEvent.click(screen.getByRole('button', { name: '重新标注' }))
    expect(screen.getByRole('button', { name: '标注已失效' })).toHaveAttribute(
      'aria-disabled',
      'true',
    )
  })

  it('外部插入请求只消费一次且继续使用原来的光标', async () => {
    let changed: EditInstruction[] = []
    function Example() {
      const [value, setValue] = useState<EditInstruction[]>([])
      const [pending, setPending] = useState<{
        kind: 'annotation'
        id: string
        requestId: number
      } | null>(null)
      return (
        <>
          <EditInstructionEditor
            value={value}
            onChange={(parts) => {
              changed = parts
              setValue(parts)
            }}
            annotations={annotations}
            references={references}
            onSelectAnnotation={() => {}}
            onPreviewReference={() => {}}
            pendingInsertion={pending}
            onInserted={() => {
              setPending(null)
            }}
          />
          <button
            onClick={() => {
              setPending({ kind: 'annotation', id: 'a-original', requestId: 1 })
            }}
          >
            引用画布标注
          </button>
        </>
      )
    }
    await renderWithProviders(<Example />)
    const editor = screen.getByRole('textbox', { name: '修改要求' })
    editor.focus()
    paste(editor, '修改')
    fireEvent.click(screen.getByRole('button', { name: '引用画布标注' }))
    expect(changed).toEqual([
      { kind: 'text', text: '修改' },
      { kind: 'annotation', id: 'a-original' },
    ])
    fireEvent.click(screen.getByRole('button', { name: '引用画布标注' }))
    expect(screen.getAllByRole('button', { name: '标注 1' })).toHaveLength(1)
  })

  it('粘贴引用外观的文字不猜测图片身份', async () => {
    let changed: EditInstruction[] = []
    await renderWithProviders(
      <EditInstructionEditor
        value={[]}
        onChange={(parts) => {
          changed = parts
        }}
        annotations={annotations}
        references={references}
        onSelectAnnotation={() => {}}
        onPreviewReference={() => {}}
      />,
    )
    paste(screen.getByRole('textbox', { name: '修改要求' }), '【标注 1】\n【参考图 2】')
    expect(changed).toEqual([{ kind: 'text', text: '【标注 1】\n【参考图 2】' }])
    expect(screen.queryByRole('button', { name: '标注 1' })).not.toBeInTheDocument()
  })

  it('生成期间禁用文字编辑及插入入口', async () => {
    await renderWithProviders(
      <EditInstructionEditor
        value={[]}
        onChange={() => {}}
        annotations={annotations}
        references={references}
        onSelectAnnotation={() => {}}
        onPreviewReference={() => {}}
        disabled
      />,
    )
    expect(screen.getByRole('textbox', { name: '修改要求' })).toHaveAttribute(
      'contenteditable',
      'false',
    )
    expect(screen.getByRole('button', { name: '插入引用' })).toBeDisabled()
  })
})
