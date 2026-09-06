import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { server } from '@/testing/mocks/server'
import { zTaskInputsOutput } from '@/shared/api/generated/zod.gen'
import { mockAuthUser, mockTasks } from '@/testing/mocks/handlers'
import { renderWithProviders } from '@/testing/render'
import { TasksRoute } from './tasks-route'

// 通过 MSW 登录设置会话，保持 /users/me 路径与实际应用一致。
const login = async () => {
  await fetch('/api/auth/login', {
    body: new URLSearchParams({ password: 'x', username: 'tester' }),
    method: 'POST',
  })
}

const makeTask = (overrides: Partial<(typeof mockTasks)[number]>) => ({
  assigneeUserIds: [],
  inputs: zTaskInputsOutput.parse({
    video_spec: { aspect_ratio: null, duration_seconds: null },
    reference_video_oss_url: null,
    product: { style_no: 'SBPU24001W', image_oss_urls: [] },
    reference_image_oss_urls: { model: [], outfit: [], prop: [] },
  }),
  createdAt: new Date().toISOString(),
  creatorUserId: mockAuthUser.id,
  deadline: null,
  id: crypto.randomUUID(),
  priority: 0,
  status: 'draft' as const,
  title: '未命名需求单',
  updatedAt: new Date().toISOString(),
  ...overrides,
})

const renderLoggedIn = async () => {
  await login()
  return renderWithProviders(<TasksRoute />)
}

describe('TasksRoute', () => {
  afterEach(() => vi.unstubAllGlobals())
  it('渲染两个分区与卡片', async () => {
    mockTasks.push(
      makeTask({ status: 'published', title: '夏季新品视频' }),
      makeTask({
        assigneeUserIds: [mockAuthUser.id],
        status: 'confirmed',
        title: '我认领的需求单',
      }),
    )
    await renderLoggedIn()

    expect(await screen.findByText('夏季新品视频')).toBeVisible()
    expect(screen.getAllByText('我认领的需求单')).toHaveLength(2)

    const mine = screen.getByRole('region', { name: '我的需求单' })
    expect(within(mine).getByText('我认领的需求单')).toBeVisible()
    expect(within(mine).queryByText('夏季新品视频')).not.toBeInTheDocument()
  })

  it('完整创建后回读创作规格和商品内容，时长比例与分辨率均保留', async () => {
    const user = userEvent.setup()
    await renderLoggedIn()

    await user.click(await screen.findByRole('button', { name: '新建需求单' }))
    const dialog = await screen.findByRole('dialog')
    await user.type(within(dialog).getByLabelText('需求单名称'), '新品测评视频')
    await user.type(within(dialog).getByLabelText('商品款号'), 'SBPU24001W')
    await user.type(within(dialog).getByLabelText('商品名称'), '轻薄防晒衣')
    await user.type(within(dialog).getByLabelText('发布平台'), 'douyin')
    await user.type(within(dialog).getByLabelText('视频类型'), 'product_showcase')
    await user.type(within(dialog).getByLabelText('内容类型'), 'short_video')
    expect(within(dialog).getByLabelText('发布平台')).toHaveValue('抖音')
    expect(within(dialog).getByLabelText('视频类型')).toHaveValue('产品展示')
    expect(within(dialog).getByLabelText('内容类型')).toHaveValue('短视频')
    await user.type(within(dialog).getByLabelText('分辨率'), '1080p')
    await user.selectOptions(within(dialog).getByLabelText('比例'), '9:16')
    await user.type(within(dialog).getByLabelText('目标时长（秒）'), '15')
    await user.type(within(dialog).getByLabelText('创作要求'), '展示面料的轻薄透气')
    await user.click(within(dialog).getByRole('button', { name: '创建需求单' }))

    expect(await screen.findByText('新品测评视频')).toBeVisible()
    expect(mockTasks[0]?.inputs).toEqual({
      video_spec: {
        platform: 'douyin',
        video_type: 'product_showcase',
        content_type: 'short_video',
        resolution: '1080p',
        aspect_ratio: '9:16',
        duration_seconds: 15,
      },
      product: { style_no: 'SBPU24001W', name: '轻薄防晒衣', image_oss_urls: [] },
      reference_image_oss_urls: { model: [], outfit: [], prop: [] },
      reference_video_oss_url: null,
      creative_requirement: '展示面料的轻薄透气',
    })
    await user.click(screen.getByText('新品测评视频'))
    const reopened = await screen.findByRole('dialog')
    expect(within(reopened).getByLabelText('商品名称')).toHaveValue('轻薄防晒衣')
    expect(within(reopened).getByLabelText('目标时长（秒）')).toHaveValue(15)
    expect(within(reopened).getByLabelText('分辨率')).toHaveValue('1080p')
    expect(within(reopened).getByLabelText('比例')).toHaveValue('9:16')
  })

  it('认领 published 需求单后出现在我的需求单', async () => {
    mockTasks.push(makeTask({ status: 'published', title: '待认领的需求单' }))
    const user = userEvent.setup()
    await renderLoggedIn()

    await user.click(await screen.findByText('待认领的需求单'))
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: '认领' }))

    const mine = screen.getByRole('region', { name: '我的需求单' })
    await waitFor(() => expect(within(mine).getByText('待认领的需求单')).toBeVisible())
  })

  it('详情弹窗补充需求描述后保存', async () => {
    const task = makeTask({
      assigneeUserIds: [mockAuthUser.id],
      status: 'confirmed',
      title: '进行中的需求单',
    })
    mockTasks.push(task)
    const user = userEvent.setup()
    await renderLoggedIn()

    const mine = screen.getByRole('region', { name: '我的需求单' })
    await user.click(await within(mine).findByText('进行中的需求单'))
    const dialog = await screen.findByRole('dialog')
    await user.type(within(dialog).getByLabelText('创作要求'), '补充：要 15 秒版本')
    await user.click(within(dialog).getByRole('button', { name: '保存' }))

    await waitFor(() =>
      expect(mockTasks[0]?.inputs.creative_requirement).toBe('补充：要 15 秒版本'),
    )
  })

  it('我的需求单卡片菜单里重命名需求单', async () => {
    const task = makeTask({
      assigneeUserIds: [mockAuthUser.id],
      status: 'confirmed',
      title: '进行中的需求单',
    })
    mockTasks.push(task)
    const user = userEvent.setup()
    await renderLoggedIn()

    const all = screen.getByRole('region', { name: '全部需求单' })
    await within(all).findByText('进行中的需求单')
    expect(within(all).queryByRole('button', { name: '更多操作' })).toBeNull()

    const mine = screen.getByRole('region', { name: '我的需求单' })
    await user.click(await within(mine).findByRole('button', { name: '更多操作' }))
    await user.click(await screen.findByRole('menuitem', { name: '重命名' }))

    const dialog = await screen.findByRole('dialog', { name: '重命名需求单' })
    const input = within(dialog).getByLabelText('新的需求单名称')
    await user.clear(input)
    await user.type(input, '改名后的需求单')
    await user.click(within(dialog).getByRole('button', { name: '保存' }))

    await waitFor(() => expect(task.title).toBe('改名后的需求单'))
    expect(await within(mine).findByText('改名后的需求单')).toBeVisible()
  })
  it('发布后冻结商品和平台类型，仍可调整创作参数和参考素材', async () => {
    mockTasks.push(makeTask({ status: 'published', title: '已发布需求' }))
    const user = userEvent.setup()
    await renderLoggedIn()
    await user.click(await screen.findByText('已发布需求'))
    const dialog = await screen.findByRole('dialog')
    for (const label of ['商品款号', '商品名称', '发布平台', '视频类型', '内容类型']) {
      expect(within(dialog).getByLabelText(label)).toBeDisabled()
    }
    expect(within(dialog).queryByRole('button', { name: '添加商品图片' })).not.toBeInTheDocument()
    for (const label of ['分辨率', '比例', '目标时长（秒）', '创作要求']) {
      expect(within(dialog).getByLabelText(label)).toBeEnabled()
    }
    expect(within(dialog).getByRole('button', { name: '添加模特参考图' })).toBeEnabled()
  })

  it('撤回的需求单只读，不能保存或添加素材', async () => {
    mockTasks.push(makeTask({ status: 'withdrawn', title: '已撤回需求' }))
    const user = userEvent.setup()
    await renderLoggedIn()
    await user.click(await screen.findByText('已撤回需求'))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByLabelText('需求单名称')).toBeDisabled()
    expect(within(dialog).getByLabelText('创作要求')).toBeDisabled()
    expect(within(dialog).queryByRole('button', { name: '保存' })).not.toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: '添加模特参考图' })).not.toBeInTheDocument()
  })
  it('商品图和拖放参考图并行上传时保留输入，全部上传完成才允许创建', async () => {
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn().mockResolvedValue({ close: vi.fn(), height: 800, width: 600 }),
    )
    const ids = ['5baea4c7-4d82-48a2-9d3b-62c9f2f1b101', '5baea4c7-4d82-48a2-9d3b-62c9f2f1b102']
    let signed = 0
    let releaseProduct: (() => void) | undefined
    let releaseModel: (() => void) | undefined
    const productReady = new Promise<void>((resolve) => {
      releaseProduct = resolve
    })
    const modelReady = new Promise<void>((resolve) => {
      releaseModel = resolve
    })
    server.use(
      http.post('*/api/uploads/sign', () => {
        const assetId = ids[signed++]
        return HttpResponse.json({
          assetId,
          upload: {
            expiresAt: '2026-10-01T00:00:00Z',
            headers: {},
            url: `http://localhost/mock-oss/${assetId}`,
          },
        })
      }),
      http.post('*/api/assets/:assetId', async ({ params }) => {
        const id = String(params['assetId'])
        await (id === ids[0] ? productReady : modelReady)
        return HttpResponse.json({
          asset: {
            id,
            assetType: 'image',
            contentType: 'image/png',
            createdAt: new Date().toISOString(),
            creatorUserId: mockAuthUser.id,
            sizeBytes: 100,
            url: `http://localhost/mock-oss/${id}`,
          },
        })
      }),
    )
    const user = userEvent.setup()
    await renderLoggedIn()
    await user.click(await screen.findByRole('button', { name: '新建需求单' }))
    const dialog = await screen.findByRole('dialog')
    await user.type(within(dialog).getByLabelText('需求单名称'), '并行上传需求')
    await user.type(within(dialog).getByLabelText('商品款号'), 'TEST-001')
    await user.upload(
      within(dialog).getByLabelText('选择商品图片文件'),
      new File(['image'], '商品.png', { type: 'image/png' }),
    )
    await waitFor(() => expect(signed).toBe(1))
    fireEvent.drop(within(dialog).getByRole('group', { name: '模特参考图' }), {
      dataTransfer: {
        types: ['Files'],
        items: [],
        files: [new File(['image'], '模特.png', { type: 'image/png' })],
      },
    })
    await waitFor(() => expect(signed).toBe(2))
    await user.type(within(dialog).getByLabelText('创作要求'), '上传期间补充的要求')
    releaseProduct?.()
    expect(await within(dialog).findByRole('button', { name: '预览商品图片 1' })).toBeVisible()
    expect(within(dialog).getByRole('button', { name: '创建需求单' })).toBeDisabled()
    releaseModel?.()
    expect(await within(dialog).findByRole('button', { name: '预览模特参考图 1' })).toBeVisible()
    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: '创建需求单' })).toBeEnabled(),
    )
    await user.click(within(dialog).getByRole('button', { name: '创建需求单' }))
    await waitFor(() => expect(mockTasks).toHaveLength(1))
    expect(mockTasks[0]?.inputs.creative_requirement).toBe('上传期间补充的要求')
    expect(mockTasks[0]?.inputs.product.image_oss_urls).toEqual([
      `http://localhost/mock-oss/${ids[0]}`,
    ])
    expect(mockTasks[0]?.inputs.reference_image_oss_urls?.model).toEqual([
      `http://localhost/mock-oss/${ids[1]}`,
    ])
  })

  it('只有查看权限时详情只读', async () => {
    server.use(
      http.get('*/api/users/me', () =>
        HttpResponse.json({ user: { ...mockAuthUser, permissions: ['tasks:read'] } }),
      ),
    )
    mockTasks.push(makeTask({ status: 'published', title: '只读需求' }))
    const user = userEvent.setup()
    await renderLoggedIn()
    await user.click(await screen.findByText('只读需求'))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByLabelText('创作要求')).toBeDisabled()
    expect(within(dialog).queryByRole('button', { name: '保存' })).not.toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: '认领' })).not.toBeInTheDocument()
  })
  it('其他人草稿不可编辑或发布', async () => {
    mockTasks.push(
      makeTask({ creatorUserId: '4133e687-07d8-4460-a0dc-954f802697f4', title: '他人草稿' }),
    )
    const user = userEvent.setup()
    await renderLoggedIn()
    await user.click(await screen.findByText('他人草稿'))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByLabelText('需求单名称')).toBeDisabled()
    expect(within(dialog).getByLabelText('创作要求')).toBeDisabled()
    expect(within(dialog).getByRole('button', { name: '保存' })).toBeDisabled()
    expect(within(dialog).queryByRole('button', { name: '发布' })).not.toBeInTheDocument()
  })
  it('详情加载失败显示错误，可重试恢复', async () => {
    const task = makeTask({ title: '读取重试需求' })
    mockTasks.push(task)
    let unavailable = true
    server.use(
      http.get('*/api/tasks/:taskId', () =>
        unavailable
          ? HttpResponse.json({ detail: '暂时无法读取需求单' }, { status: 503 })
          : HttpResponse.json({ task }),
      ),
    )
    const user = userEvent.setup()
    await renderLoggedIn()
    await user.click(await screen.findByText('读取重试需求'))
    const dialog = await screen.findByRole('dialog')
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('暂时无法读取需求单')
    unavailable = false
    await user.click(within(dialog).getByRole('button', { name: '重试' }))
    expect(await within(dialog).findByLabelText('需求单名称')).toHaveValue('读取重试需求')
  })
  it('草稿修改后必须先保存，再发布最新内容', async () => {
    const task = makeTask({ deadline: '2026-10-01T12:00:00Z', title: '待修改草稿' })
    mockTasks.push(task)
    const user = userEvent.setup()
    await renderLoggedIn()
    await user.click(await screen.findByText('待修改草稿'))
    const dialog = await screen.findByRole('dialog')
    const publish = within(dialog).getByRole('button', { name: '发布' })
    expect(publish).toBeEnabled()
    await user.type(within(dialog).getByLabelText('创作要求'), '要保留的新要求')
    expect(publish).toBeDisabled()
    expect(within(dialog).getByText('先保存修改，再发布')).toBeVisible()
    await user.click(publish)
    expect(task.status).toBe('draft')
    expect(task.inputs.creative_requirement).toBe('')
    expect(within(dialog).getByRole('button', { name: '保存' })).toBeEnabled()
    await user.click(within(dialog).getByRole('button', { name: '保存' }))
    await waitFor(() => expect(task.inputs.creative_requirement).toBe('要保留的新要求'))
    await user.click(await screen.findByText('待修改草稿'))
    const savedDialog = await screen.findByRole('dialog')
    expect(within(savedDialog).getByRole('button', { name: '发布' })).toBeEnabled()
    expect(within(savedDialog).queryByText('先保存修改，再发布')).not.toBeInTheDocument()
    await user.click(within(savedDialog).getByRole('button', { name: '发布' }))
    await waitFor(() => expect(task.status).toBe('published'))
  })
})
