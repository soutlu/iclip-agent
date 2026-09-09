import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { JsonTree } from './json-tree'

const IMAGE = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E"

describe('JsonTree', () => {
  it('对象与数组是可折叠节点，键在前、形状在后；点一下收起子项', async () => {
    render(<JsonTree text={JSON.stringify({ cells: [{ id: 'S1-1' }], layout: '1x1' })} />)

    expect(screen.getByRole('button', { name: '收起 cells' })).toHaveTextContent('[1]')
    expect(screen.getByText('S1-1')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: '收起 cells' }))

    expect(screen.queryByText('S1-1')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '展开 cells' })).toBeVisible()
    expect(screen.getByText('1x1')).toBeVisible()
  })

  it('图片地址显示成缩略图，视频与别的地址是外链', () => {
    render(
      <JsonTree
        text={JSON.stringify({
          poster: 'https://cdn.example/out/S2-1.jpg?x=1',
          site: 'https://example.com/about',
          video: 'https://cdn.example/uploads/clip.mp4',
        })}
      />,
    )

    expect(screen.getByRole('img', { name: '预览 S2-1.jpg' })).toHaveAttribute(
      'src',
      'https://cdn.example/out/S2-1.jpg?x=1',
    )
    expect(screen.getByRole('link', { name: /clip\.mp4/ })).toHaveAttribute(
      'href',
      'https://cdn.example/uploads/clip.mp4',
    )
    expect(screen.getByRole('link', { name: 'https://example.com/about' })).toBeVisible()
  })

  it('data 地址的图也认', () => {
    render(<JsonTree text={JSON.stringify({ url: IMAGE })} />)
    expect(screen.getByRole('img')).toHaveAttribute('src', IMAGE)
  })

  it('解析失败明说，并退回带行号的原文', () => {
    render(<JsonTree text={'{\n  "a": 1,\n}'} />)

    expect(screen.getByRole('alert')).toHaveTextContent('不是合法的 JSON')
    expect(screen.getByText('"a": 1,')).toBeVisible()
  })
})
