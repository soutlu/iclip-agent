import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Shot } from '../shots'
import { AllShotsSheet } from './all-shots-sheet'

const shots: Shot[] = [
  { imageUrls: ['a.png'], index: 1, prompt: '[0–4秒｜镜头1]\n模特走出门厅 @Image1。', seconds: 4 },
  {
    imageUrls: ['b.png'],
    index: 2,
    prompt: '[0–5秒｜镜头1]\n走到近处停下微笑 @Image1。',
    seconds: 5,
  },
  { imageUrls: [], index: 3, prompt: '[0–6秒｜镜头1]\n低角度拍鞋面。', seconds: 6 },
]

const renderSheet = () => {
  const props = {
    aspectRatio: '9:16',
    onClose: vi.fn(),
    onGenerate: vi.fn(),
    onOpenShot: vi.fn(),
    onTalk: vi.fn(),
    running: new Set([2]),
    shots,
    videos: new Map([[1, 'take-1.mp4']]),
  }
  render(<AllShotsSheet {...props} />)
  return props
}

const pick = async (index: number) => {
  await userEvent.click(screen.getByRole('button', { name: `选中镜头组 ${index}` }))
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('AllShotsSheet', () => {
  it('每组一卡：时长、序号、状态圆点', () => {
    renderSheet()

    expect(screen.getByText('4 秒')).toBeVisible()
    expect(screen.getByText('第 3 组')).toBeVisible()
    expect(screen.getByRole('img', { name: '正在出片' })).toBeVisible()
    expect(screen.getByRole('img', { name: '已出片' })).toBeVisible()
  })

  it('勾选与全选都记在「已选 N 个」上', async () => {
    renderSheet()

    await pick(1)
    await pick(3)
    expect(screen.getByText('已选 2 个')).toBeVisible()

    await userEvent.click(screen.getByRole('button', { name: '全选' }))
    expect(screen.getByText('已选 3 个')).toBeVisible()

    await userEvent.click(screen.getByRole('button', { name: '取消全选' }))
    expect(screen.getByText('已选 0 个')).toBeVisible()
  })

  it('复制 prompt：选中各组的描述用空行拼起来写进剪贴板', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    renderSheet()

    await pick(1)
    await pick(3)
    await userEvent.click(screen.getByRole('button', { name: '复制 prompt' }))

    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(`${shots[0]?.prompt}\n\n${shots[2]?.prompt}`),
    )
  })

  it('下载成片：有成片的各开一页，没有的跳过', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    renderSheet()

    await pick(1)
    await pick(2)
    await userEvent.click(screen.getByRole('button', { name: '下载成片' }))

    expect(open).toHaveBeenCalledTimes(1)
    expect(open).toHaveBeenCalledWith('take-1.mp4', '_blank', 'noopener')
  })

  it('批量出片先确认条数，确认了才逐组发', async () => {
    const { onGenerate } = renderSheet()

    await userEvent.click(screen.getByRole('button', { name: '全选' }))
    await userEvent.click(screen.getByRole('button', { name: '生成选中的 3 组' }))

    const dialog = await screen.findByRole('dialog', { name: '确认批量出片' })
    expect(within(dialog).getByText(/3 组/)).toBeVisible()
    expect(onGenerate).not.toHaveBeenCalled()

    await userEvent.click(within(dialog).getByRole('button', { name: '发出去' }))
    expect(onGenerate).toHaveBeenCalledWith([1, 2, 3])
  })

  it('一组都没选时批量动作都点不动', () => {
    renderSheet()

    expect(screen.getByRole('button', { name: '生成选中的 0 组' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '复制 prompt' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '下载成片' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '在聊天里说' })).toBeDisabled()
  })

  it('点卡正文是翻到那一组，不是选中它', async () => {
    const { onOpenShot } = renderSheet()

    await userEvent.click(screen.getByText('走到近处停下微笑'))

    expect(onOpenShot).toHaveBeenCalledWith(2)
    expect(screen.getByText('已选 0 个')).toBeVisible()
  })

  it('「在聊天里说」把选中的几组交出去', async () => {
    const { onTalk } = renderSheet()

    await pick(2)
    await userEvent.click(screen.getByRole('button', { name: '在聊天里说' }))

    expect(onTalk).toHaveBeenCalledWith([2])
  })
})
