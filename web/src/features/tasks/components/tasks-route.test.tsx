import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { server } from '@/testing/mocks/server'
import { zTaskInputsOutput } from '@/shared/api/generated/zod.gen'
import { mockAuthUser, mockTasks } from '@/testing/mocks/handlers'
import { renderWithProviders } from '@/testing/render'
import type { TaskCreationDraft } from '../task-creation'
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
    products: [{ style_no: 'SBPU24001W', image_oss_urls: [] }],
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

const renderLoggedIn = async (onStartCreation?: (draft: TaskCreationDraft) => Promise<void>) => {
  await login()
  return renderWithProviders(<TasksRoute {...(onStartCreation ? { onStartCreation } : {})} />)
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

  it('创建后回读规格、多款商品、分类参考图与单视频，字段归属保持一致', async () => {
    vi.stubGlobal('createImageBitmap', async () => ({
      close: () => {},
      height: 800,
      width: 600,
    }))
    const user = userEvent.setup()
    await renderLoggedIn()

    await user.click(await screen.findByRole('button', { name: '新建需求单' }))
    const dialog = await screen.findByRole('dialog')
    const fillText = async (label: string, value: string) => {
      await user.click(within(dialog).getByLabelText(label))
      await user.paste(value)
    }
    await fillText('需求单名称', '新品测评视频')
    fireEvent.change(within(dialog).getByLabelText('截止时间'), {
      target: { value: '2026-10-01T18:30' },
    })
    await fillText('商品 1 款号', 'SBPU24001W')
    await fillText('商品 1 名称', '轻薄防晒衣')
    await fillText('商品 1 品牌', '品牌甲')
    await fillText('商品 1 品类', '外套')
    await fillText('商品 1 颜色', '白色')
    expect(within(dialog).queryByRole('button', { name: '移除商品 1' })).not.toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: '添加商品' }))
    await user.click(within(dialog).getByRole('button', { name: '添加商品' }))
    await fillText('商品 3 款号', 'SBPU24003W')
    await user.click(within(dialog).getByRole('button', { name: '移除商品 2' }))
    expect(within(dialog).getByLabelText('商品 2 款号')).toHaveValue('SBPU24003W')
    expect(within(dialog).queryByLabelText('商品 3 款号')).not.toBeInTheDocument()
    await fillText('发布平台', 'douyin')
    await fillText('视频类型', 'product_showcase')
    await fillText('内容类型', 'short_video')
    expect(within(dialog).getByLabelText('发布平台')).toHaveValue('抖音')
    expect(within(dialog).getByLabelText('视频类型')).toHaveValue('产品展示')
    expect(within(dialog).getByLabelText('内容类型')).toHaveValue('短视频')
    await fillText('分辨率', '1080p')
    await user.selectOptions(within(dialog).getByLabelText('比例'), '9:16')
    await user.type(within(dialog).getByLabelText('目标时长（秒）'), '15')
    await fillText('创作要求', '展示面料的轻薄透气')

    const uploadReferenceImage = async (label: string) => {
      await user.upload(
        within(dialog).getByLabelText(`选择${label}文件`),
        new File(['image'], `${label}.png`, { type: 'image/png' }),
      )
      const image = await within(dialog).findByRole<HTMLImageElement>('img', { name: `${label} 1` })
      return image.src
    }
    const modelUrl = await uploadReferenceImage('模特参考图')
    const outfitUrl = await uploadReferenceImage('穿搭参考图')
    const propUrl = await uploadReferenceImage('道具参考图')
    const productUrl = await uploadReferenceImage('商品 2 图片')
    await user.upload(
      within(dialog).getByLabelText('选择参考视频文件'),
      new File(['video'], '参考.mp4', { type: 'video/mp4' }),
    )
    await user.click(await within(dialog).findByRole('button', { name: '预览参考视频 1' }))
    const videoUrl = screen.getByLabelText<HTMLVideoElement>('参考视频 1', {
      selector: 'video',
    }).src
    await user.click(
      within(screen.getByRole('dialog', { name: '参考视频 1' })).getByRole('button', {
        name: '关闭预览',
      }),
    )
    await user.click(within(dialog).getByRole('button', { name: '创建需求单' }))

    expect(await screen.findByText('新品测评视频')).toBeVisible()
    expect(mockTasks[0]?.deadline).toBe(new Date('2026-10-01T18:30').toISOString())
    expect(mockTasks[0]?.inputs).toEqual({
      video_spec: {
        platform: 'douyin',
        video_type: 'product_showcase',
        content_type: 'short_video',
        resolution: '1080p',
        aspect_ratio: '9:16',
        duration_seconds: 15,
      },
      products: [
        {
          style_no: 'SBPU24001W',
          name: '轻薄防晒衣',
          brand: '品牌甲',
          category: '外套',
          color_name: '白色',
          image_oss_urls: [],
        },
        {
          style_no: 'SBPU24003W',
          name: '',
          brand: '',
          category: '',
          color_name: '',
          image_oss_urls: [productUrl],
        },
      ],
      reference_image_oss_urls: { model: [modelUrl], outfit: [outfitUrl], prop: [propUrl] },
      reference_video_oss_url: videoUrl,
      creative_requirement: '展示面料的轻薄透气',
    })
    expect(screen.getByText(/SBPU24001W 等 2 款/)).toBeVisible()
    await user.click(screen.getByText('新品测评视频'))
    const reopened = await screen.findByRole('dialog')
    expect(within(reopened).getByLabelText('截止时间')).toHaveValue('2026-10-01T18:30')
    expect(within(reopened).getByLabelText('商品 1 名称')).toHaveValue('轻薄防晒衣')
    expect(within(reopened).getByLabelText('商品 1 品牌')).toHaveValue('品牌甲')
    expect(within(reopened).getByLabelText('商品 1 品类')).toHaveValue('外套')
    expect(within(reopened).getByLabelText('商品 1 颜色')).toHaveValue('白色')
    expect(within(reopened).getByLabelText('商品 2 款号')).toBeDisabled()
    expect(within(reopened).getByLabelText('商品 2 名称')).toBeEnabled()
    expect(within(reopened).queryByRole('button', { name: '添加商品' })).not.toBeInTheDocument()
    expect(within(reopened).queryByRole('button', { name: '移除商品 2' })).not.toBeInTheDocument()
    expect(within(reopened).getByLabelText('目标时长（秒）')).toHaveValue(15)
    expect(within(reopened).getByLabelText('分辨率')).toHaveValue('1080p')
    expect(within(reopened).getByLabelText('比例')).toHaveValue('9:16')
    expect(within(reopened).getByLabelText('发布平台')).toHaveValue('抖音')
    expect(within(reopened).getByLabelText('视频类型')).toHaveValue('产品展示')
    expect(within(reopened).getByLabelText('内容类型')).toHaveValue('短视频')
    expect(within(reopened).getByLabelText('创作要求')).toHaveValue('展示面料的轻薄透气')
    expect(within(reopened).getByRole('img', { name: '商品 2 图片 1' })).toHaveAttribute(
      'src',
      productUrl,
    )
    expect(within(reopened).getByRole('img', { name: '模特参考图 1' })).toHaveAttribute(
      'src',
      modelUrl,
    )
    expect(within(reopened).getByRole('img', { name: '穿搭参考图 1' })).toHaveAttribute(
      'src',
      outfitUrl,
    )
    expect(within(reopened).getByRole('img', { name: '道具参考图 1' })).toHaveAttribute(
      'src',
      propUrl,
    )
    await user.click(within(reopened).getByRole('button', { name: '预览参考视频 1' }))
    expect(screen.getByLabelText('参考视频 1', { selector: 'video' })).toHaveAttribute(
      'src',
      videoUrl,
    )
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
    for (const label of [
      '商品 1 款号',
      '商品 1 名称',
      '商品 1 品牌',
      '商品 1 品类',
      '商品 1 颜色',
      '发布平台',
      '视频类型',
      '内容类型',
    ]) {
      expect(within(dialog).getByLabelText(label)).toBeDisabled()
    }
    expect(
      within(dialog).queryByRole('button', { name: '添加商品 1 图片' }),
    ).not.toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: '添加商品' })).not.toBeInTheDocument()
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
    await user.type(within(dialog).getByLabelText('商品 1 款号'), 'TEST-001')
    await user.upload(
      within(dialog).getByLabelText('选择商品 1 图片文件'),
      new File(['image'], '商品.png', { type: 'image/png' }),
    )
    await waitFor(() => expect(signed).toBe(1))
    expect(within(dialog).queryByRole('button', { name: '添加商品' })).not.toBeInTheDocument()
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
    expect(await within(dialog).findByRole('button', { name: '预览商品 1 图片 1' })).toBeVisible()
    expect(within(dialog).getByRole('button', { name: '创建需求单' })).toBeDisabled()
    releaseModel?.()
    expect(await within(dialog).findByRole('button', { name: '预览模特参考图 1' })).toBeVisible()
    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: '创建需求单' })).toBeEnabled(),
    )
    expect(within(dialog).getByRole('button', { name: '添加商品' })).toBeVisible()
    await user.click(within(dialog).getByRole('button', { name: '创建需求单' }))
    await waitFor(() => expect(mockTasks).toHaveLength(1))
    expect(mockTasks[0]?.inputs.creative_requirement).toBe('上传期间补充的要求')
    expect(mockTasks[0]?.inputs.products.map((product) => product.image_oss_urls)).toEqual([
      [`http://localhost/mock-oss/${ids[0]}`],
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
  it('预览返回不提交，失败保留同一发送草稿并可重试', async () => {
    const task = makeTask({
      status: 'confirmed',
      assigneeUserIds: [mockAuthUser.id],
      title: '开始创作的需求',
    })
    task.inputs.creative_requirement = '  保留原文\n口播：Hello!  '
    task.inputs.video_spec.aspect_ratio = '9:16'
    task.inputs.products = task.inputs.products.map((product) => ({
      ...product,
      image_oss_urls: ['https://assets.example.com/product.png'],
    }))
    task.inputs.reference_image_oss_urls.model = ['https://assets.example.com/model.png']
    task.inputs.reference_image_oss_urls.outfit = ['https://assets.example.com/excluded.png']
    mockTasks.push(task)
    const sent: TaskCreationDraft[] = []
    const user = userEvent.setup()
    await renderLoggedIn(async (draft) => {
      sent.push(draft)
      if (sent.length === 1) throw new Error('启动连接失败，可重试')
    })
    const mine = screen.getByRole('region', { name: '我的需求单' })
    await user.click(await within(mine).findByText(task.title))
    let dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: '开始创作' }))
    dialog = await screen.findByRole('dialog', { name: '发起创作' })
    const previewText = within(dialog).getByLabelText('发送文字预览')
    expect(previewText).toHaveAttribute('readonly')
    expect((previewText as HTMLTextAreaElement).value).toContain(task.inputs.creative_requirement)
    expect(within(dialog).getAllByRole('img')).toHaveLength(2)
    expect(sent).toHaveLength(0)
    await user.click(within(dialog).getByRole('button', { name: '返回修改' }))
    expect(within(await screen.findByRole('dialog')).getByLabelText('创作要求')).toHaveValue(
      task.inputs.creative_requirement,
    )
    expect(sent).toHaveLength(0)
    await user.click(screen.getByRole('button', { name: '开始创作' }))
    await user.click(screen.getByRole('button', { name: '确认并开始' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('启动连接失败，可重试')
    expect(screen.getByLabelText<HTMLTextAreaElement>('发送文字预览').value).toContain(
      task.inputs.creative_requirement,
    )
    await user.click(screen.getByRole('button', { name: '确认并开始' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(sent).toHaveLength(2)
    expect(sent[1]).toBe(sent[0])
    expect(sent[0]?.content.filter((part) => part.type === 'text')).toHaveLength(1)
    expect(task.inputs.creative_requirement).toBe('  保留原文\n口播：Hello!  ')
  })

  it('已认领需求有未保存修改时先保存，空创作内容不能开始', async () => {
    const task = makeTask({
      status: 'confirmed',
      assigneeUserIds: [mockAuthUser.id],
      title: '需保存后开始',
    })
    task.inputs.creative_requirement = '已有创作要求'
    const emptyTask = makeTask({
      status: 'confirmed',
      assigneeUserIds: [mockAuthUser.id],
      title: '没有创作内容的需求',
    })
    mockTasks.push(task, emptyTask)
    const user = userEvent.setup()
    await renderLoggedIn(async () => {})
    await user.click(
      await within(screen.getByRole('region', { name: '我的需求单' })).findByText(task.title),
    )
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByRole('button', { name: '开始创作' })).toBeEnabled()
    await user.type(within(dialog).getByLabelText('创作要求'), '补充内容')
    expect(within(dialog).getByRole('button', { name: '开始创作' })).toBeDisabled()
    expect(within(dialog).getByText('先保存修改，再开始创作')).toBeVisible()
    expect(within(dialog).getByRole('button', { name: '保存' })).toBeEnabled()
    await user.click(within(dialog).getByRole('button', { name: '关闭' }))
    await user.click(
      await within(screen.getByRole('region', { name: '我的需求单' })).findByText(emptyTask.title),
    )
    expect(screen.getByRole('button', { name: '开始创作' })).toBeDisabled()
    expect(screen.getByText('请补充创作要求、视频规格或参考素材后开始')).toBeVisible()
  })

  it.each([
    { status: 'confirmed', claimed: false, canRun: true },
    { status: 'published', claimed: true, canRun: true },
    { status: 'confirmed', claimed: true, canRun: false },
  ])('开始入口要求已认领、confirmed和agent:run：%j', async ({ status, claimed, canRun }) => {
    server.use(
      http.get('*/api/users/me', () =>
        HttpResponse.json({
          user: {
            ...mockAuthUser,
            permissions: canRun
              ? mockAuthUser.permissions
              : mockAuthUser.permissions.filter((permission) => permission !== 'agent:run'),
          },
        }),
      ),
    )
    const task = makeTask({
      status,
      assigneeUserIds: claimed ? [mockAuthUser.id] : [],
      title: '开始权限需求',
    })
    task.inputs.creative_requirement = '需求内容'
    mockTasks.push(task)
    const user = userEvent.setup()
    await renderLoggedIn(async () => {})
    await user.click(
      await within(screen.getByRole('region', { name: '全部需求单' })).findByText(task.title),
    )
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).queryByRole('button', { name: '开始创作' })).not.toBeInTheDocument()
  })
  it('预览后被其他窗口撤回，确认重新读取状态并阻止启动，保留原发送草稿', async () => {
    const task = makeTask({
      status: 'confirmed',
      assigneeUserIds: [mockAuthUser.id],
      title: '预览后被撤回的需求',
    })
    task.inputs.creative_requirement = '已经确认的原始需求'
    mockTasks.push(task)
    const sent: TaskCreationDraft[] = []
    const user = userEvent.setup()
    await renderLoggedIn(async (draft) => {
      sent.push(draft)
    })
    await user.click(
      await within(screen.getByRole('region', { name: '我的需求单' })).findByText(task.title),
    )
    await user.click(await screen.findByRole('button', { name: '开始创作' }))
    const preview = await screen.findByRole('dialog', { name: '发起创作' })
    task.status = 'withdrawn'
    task.inputs.creative_requirement = '另一个窗口修改的内容'
    await user.click(within(preview).getByRole('button', { name: '确认并开始' }))
    expect(await within(preview).findByRole('alert')).toHaveTextContent(
      '需求单已撤回，无法开始创作',
    )
    expect(within(preview).getByRole('button', { name: '确认并开始' })).toBeDisabled()
    expect(within(preview).getByLabelText<HTMLTextAreaElement>('发送文字预览').value).toContain(
      '已经确认的原始需求',
    )
    expect(within(preview).getByLabelText<HTMLTextAreaElement>('发送文字预览').value).not.toContain(
      '另一个窗口修改的内容',
    )
    expect(sent).toHaveLength(0)
  })
})
