import { useState } from 'react'
import { fireEvent, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { zTaskInputsOutput } from '@/shared/api/generated/zod.gen'
import { renderWithProviders } from '@/testing/render'
import type { Task } from '../tasks.api'
import { TaskCard } from './task-card'

const makeTask = (products: Task['inputs']['products']): Task => ({
  id: 'task-gallery',
  title: '秋季新品鞋款视频创作需求单',
  status: 'confirmed',
  priority: 0,
  deadline: null,
  creatorUserId: 'creator',
  assigneeUserIds: [],
  createdAt: '2026-09-21T08:00:00Z',
  updatedAt: '2026-09-21T08:00:00Z',
  inputs: zTaskInputsOutput.parse({
    video_spec: { aspect_ratio: null, duration_seconds: null },
    products,
    reference_image_oss_urls: {
      model: ['https://example.com/model.jpg'],
      outfit: ['https://example.com/outfit.jpg'],
      prop: ['https://example.com/prop.jpg'],
    },
    reference_video_oss_url: null,
  }),
})

const product = (
  styleNo: string,
  images: string[] = [],
  name = '',
): Task['inputs']['products'][number] => ({
  style_no: styleNo,
  name,
  brand: '',
  category: '',
  color_name: '',
  image_oss_urls: images,
})

function CardActions({ task }: { task: Task }) {
  const [action, setAction] = useState<string>('尚未打开')
  return (
    <>
      <TaskCard
        onClick={() => setAction('正在查看需求')}
        onRename={() => setAction('正在重命名')}
        task={task}
      />
      <p role="status">{action}</p>
    </>
  )
}

describe('TaskCard', () => {
  it('使用商品首图，保留原需求单名称和款号，不将其他商品图或参考图用作封面', async () => {
    const task = makeTask([
      product(
        'LOAFER-01',
        ['https://example.com/shoe.jpg', 'https://example.com/back.jpg'],
        '乐福鞋',
      ),
    ])
    await renderWithProviders(<TaskCard onClick={() => {}} task={task} />)

    const cover = screen.getByRole('img', { name: '乐福鞋 商品图' })
    expect(cover).toHaveAttribute('src', 'https://example.com/shoe.jpg')
    expect(screen.getAllByRole('img')).toHaveLength(1)
    expect(screen.getByText(task.title)).toBeVisible()
    expect(screen.getByText('LOAFER-01')).toBeVisible()
    expect(screen.getByRole('button', { name: `查看需求：${task.title}` })).toBeVisible()
    expect(
      screen.getByRole('button', { name: `查看需求：${task.title}` }),
    ).toHaveAccessibleDescription('LOAFER-01 进行中')
    expect(screen.queryByRole('button', { name: '更多操作' })).not.toBeInTheDocument()
  })

  it.each([2, 4, 20])('展示 %i 款的总数、前三款缩略图和正确余数', async (count) => {
    const products = Array.from({ length: count }, (_, index) =>
      product(`SHOE-${index + 1}`, [`https://example.com/shoe-${index + 1}.jpg`]),
    )
    await renderWithProviders(<TaskCard onClick={() => {}} task={makeTask(products)} />)

    expect(screen.getByText(`${count} 款`)).toBeVisible()
    expect(screen.getByText(`SHOE-1 等 ${count} 款`)).toBeVisible()
    expect(screen.getAllByRole('img').map((image) => image.getAttribute('src'))).toEqual([
      'https://example.com/shoe-1.jpg',
      ...products.slice(0, 3).map((item) => item.image_oss_urls[0]),
    ])
    if (count > 3) {
      expect(screen.getByLabelText(`另有 ${count - 3} 款商品`)).toHaveTextContent(`+${count - 3}`)
    } else {
      expect(screen.queryByLabelText(/另有/)).not.toBeInTheDocument()
    }
  })

  it('第一款无图时用后一款商品图作封面，缩略图仍保留原顺序与无图提示', async () => {
    const task = makeTask([
      product('SHOE-01'),
      product('SHOE-02', ['https://example.com/second.jpg']),
      product('SHOE-03', ['https://example.com/third.jpg']),
    ])
    await renderWithProviders(<TaskCard onClick={() => {}} task={task} />)

    expect(screen.getAllByRole('img').map((image) => image.getAttribute('src'))).toEqual([
      'https://example.com/second.jpg',
      null,
      'https://example.com/second.jpg',
      'https://example.com/third.jpg',
    ])
    expect(screen.getByRole('img', { name: 'SHOE-01 商品图，暂无商品图' })).toBeVisible()
    expect(screen.getByText('SHOE-01 等 3 款')).toBeVisible()
  })

  it('商品无图时明确占位，即使存在模特、穿搭和道具参考图也不代替商品图', async () => {
    await renderWithProviders(<TaskCard onClick={() => {}} task={makeTask([product('SHOE-01')])} />)

    expect(screen.getByText('暂无商品图')).toBeVisible()
    expect(screen.getByRole('img', { name: '需求单商品图，暂无商品图' })).not.toHaveAttribute('src')
    expect(screen.getAllByRole('img')).toHaveLength(1)
  })

  it('商品图加载失败时显示明确占位，不自动换成其他图片', async () => {
    await renderWithProviders(
      <TaskCard
        onClick={() => {}}
        task={makeTask([
          product('SHOE-01', ['https://example.com/broken.jpg', 'https://example.com/another.jpg']),
        ])}
      />,
    )

    fireEvent.error(screen.getByRole('img', { name: 'SHOE-01 商品图' }))

    expect(screen.getByText('暂无商品图')).toBeVisible()
    expect(screen.getByRole('img', { name: 'SHOE-01 商品图，商品图加载失败' })).not.toHaveAttribute(
      'src',
    )
    expect(screen.getAllByRole('img')).toHaveLength(1)
  })

  it.each(['鼠标', '键盘'])('%s 可打开整张需求单，缩略图不增加独立交互', async (input) => {
    const user = userEvent.setup()
    const task = makeTask([
      product('SHOE-01', ['https://example.com/first.jpg']),
      product('SHOE-02', ['https://example.com/second.jpg']),
    ])
    await renderWithProviders(<CardActions task={task} />)

    const card = screen.getByRole('button', { name: `查看需求：${task.title}` })
    expect(within(card).queryByRole('button')).not.toBeInTheDocument()
    if (input === '鼠标') {
      await user.click(screen.getByRole('img', { name: 'SHOE-02 商品图' }))
    } else {
      await user.tab()
      expect(card).toHaveFocus()
      await user.keyboard('{Enter}')
    }

    expect(screen.getByRole('status')).toHaveTextContent('正在查看需求')
  })

  it('更多操作无需悬停即可打开，重命名不会同时打开详情', async () => {
    const user = userEvent.setup()
    await renderWithProviders(<CardActions task={makeTask([product('SHOE-01')])} />)

    const more = screen.getByRole('button', { name: '更多操作' })
    expect(more).toBeVisible()
    await user.click(more)
    expect(screen.getByRole('menuitem', { name: '重命名' })).toBeVisible()
    await user.keyboard('{Escape}')
    expect(screen.getByRole('status')).toHaveTextContent('尚未打开')
    await user.click(more)
    await user.click(screen.getByRole('menuitem', { name: '重命名' }))

    expect(screen.getByRole('status')).toHaveTextContent('正在重命名')
  })
})
