import { Link } from '@tanstack/react-router'
import {
  type ChangeEvent,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import useRecentProjects from '@/features/home/hooks/useRecentProjects'
import {
  PROJECT_TITLE_MAX_LENGTH,
  type RecentProjectItem,
} from '@/features/home/utils/create-home.constants'
import { HomeTasksPanel } from '@/features/tasks'
import { cn } from '@/shared/lib/utils'
import HippoIcon, { type HippoIconName } from '@/shared/ui/icons/HippoIcon'
import PopupContent from '@/shared/ui/popup/PopupContent'

const WORKSPACE_TABS = [
  { id: 'tasks', label: 'Tasks' },
  { id: 'inspiration', label: 'Inspiration' },
  { id: 'storyboards', label: 'Storyboards' },
] as const

type WorkspaceTabId = (typeof WORKSPACE_TABS)[number]['id']

const INSPIRATION_CATEGORIES = ['ERP', '爆款视频', '模特形象', '场景参考'] as const

type InspirationCategory = (typeof INSPIRATION_CATEGORIES)[number]

const STORYBOARD_PROJECT_SKELETON_IDS = [
  'storyboard-project-skeleton-1',
  'storyboard-project-skeleton-2',
  'storyboard-project-skeleton-3',
]
const PROJECT_CARD_MENU_VERTICAL_LIFT = 4

/**
 * 生成上移后的项目菜单锚点矩形。
 *
 * @param rect - 三点按钮的原始视口矩形。
 * @returns 上移后的弹层定位矩形。
 */
const createLiftedProjectMenuAnchorRect = (rect: DOMRect): DOMRect => ({
  bottom: rect.bottom - PROJECT_CARD_MENU_VERTICAL_LIFT,
  height: rect.height,
  left: rect.left,
  right: rect.right,
  top: rect.top - PROJECT_CARD_MENU_VERTICAL_LIFT,
  width: rect.width,
  x: rect.x,
  y: rect.y - PROJECT_CARD_MENU_VERTICAL_LIFT,
  toJSON: () => ({
    bottom: rect.bottom - PROJECT_CARD_MENU_VERTICAL_LIFT,
    height: rect.height,
    left: rect.left,
    right: rect.right,
    top: rect.top - PROJECT_CARD_MENU_VERTICAL_LIFT,
    width: rect.width,
    x: rect.x,
    y: rect.y - PROJECT_CARD_MENU_VERTICAL_LIFT,
  }),
})

/**
 * 生成 Storyboard 卡片的跳转地址。
 *
 * 首页这一屏还按「项目」组织，而 Storyboard 工作台已经改成按需求单进（一张单一个
 * 工作台，历次尝试列在左边）。首页接本仓后端时这一屏要跟着改，见 docs/backend_api.md。
 *
 * @param project - 首页项目摘要。
 * @returns Storyboard 工作台地址。
 */
const createStoryboardProjectHref = (project: RecentProjectItem) =>
  `/storyboards/${encodeURIComponent(project.id)}`

export default function HomeWorkspaceSections() {
  const [activeTab, setActiveTab] = useState<WorkspaceTabId>('tasks')
  const {
    groups,
    isCreatingProject,
    isLoading,
    projectActionError,
    renameProject,
    renamingProjectIds,
  } = useRecentProjects({
    query: '',
  })

  const projects = useMemo(() => groups.flatMap((group) => group.items), [groups])
  const agentProjects = useMemo(
    () => projects.filter((project) => project.kind === 'agent'),
    [projects],
  )
  const storyboardProjects = agentProjects

  return (
    <section
      className="home-workspace-sections home-quick-start-enter w-full"
      aria-label="首页创作项目区"
    >
      <div
        className="home-workspace-tabs mb-6 flex items-center overflow-x-auto"
        role="tablist"
        aria-label="创作项目分类"
      >
        {WORKSPACE_TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            className="home-workspace-tab relative shrink-0 transition-colors"
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === 'tasks' ? <HomeTasksPanel /> : null}
      {activeTab === 'inspiration' ? <InspirationPanel /> : null}
      {activeTab === 'storyboards' ? (
        <StoryboardsPanel
          isCreatingProject={isCreatingProject}
          isLoading={isLoading}
          projectActionError={projectActionError}
          projects={storyboardProjects}
          renamingProjectIds={renamingProjectIds}
          onRenameProject={renameProject}
        />
      ) : null}
      <div className="home-end-marker mt-24 flex items-center gap-8 text-body font-semibold">
        <span className="h-px flex-1 bg-[var(--home-border)]" />
        <span>You've reached the end</span>
        <span className="h-px flex-1 bg-[var(--home-border)]" />
      </div>
    </section>
  )
}

/**
 * 渲染 Storyboard 项目列表和创建入口。
 *
 * @param props - Storyboard 项目面板属性。
 * @returns 使用首页统一项目卡片的 Storyboard 分组面板。
 */
function StoryboardsPanel(props: ProjectPanelProps) {
  return (
    <WorkspaceProjectsPanel
      {...props}
      loadingSkeletonIds={STORYBOARD_PROJECT_SKELETON_IDS}
      projectAriaLabelPrefix="故事板"
      projectHref={createStoryboardProjectHref}
      projectIconName="movie"
    />
  )
}

function InspirationPanel() {
  const [activeCategory, setActiveCategory] = useState<InspirationCategory>(
    INSPIRATION_CATEGORIES[0],
  )

  return (
    <div className="min-h-24">
      <div className="home-filter-chips mb-5 flex flex-wrap">
        {INSPIRATION_CATEGORIES.map((category) => (
          <button
            key={category}
            type="button"
            aria-pressed={activeCategory === category}
            className={cn(
              'home-filter-chip transition-all ui-motion-m hover:-translate-y-px active:translate-y-0',
              activeCategory === category ? 'home-filter-chip--active' : '',
            )}
            onClick={() => setActiveCategory(category)}
          >
            {category}
          </button>
        ))}
      </div>
    </div>
  )
}

interface WorkspaceProjectsPanelProps {
  isCreatingProject: boolean
  isLoading: boolean
  loadingSkeletonIds: readonly string[]
  onCreateProject?: () => void
  onRenameProject: (projectId: string, title: string) => Promise<boolean>
  projectAriaLabelPrefix: string
  projectActionError: null | string
  projectHref: (project: RecentProjectItem) => string
  projectIconName: HippoIconName
  projects: RecentProjectItem[]
  renamingProjectIds: ReadonlySet<string>
}

/**
 * 渲染首页项目分组面板。
 *
 * @param props - 项目分组面板属性。
 * @param props.isCreatingProject - 当前是否正在创建项目。
 * @param props.isLoading - 当前项目列表是否加载中。
 * @param props.loadingSkeletonIds - 加载态骨架屏 key。
 * @param props.onCreateProject - 创建当前分组项目的回调。
 * @param props.onRenameProject - 保存项目新名称的回调。
 * @param props.projectAriaLabelPrefix - 项目卡片打开动作的类型前缀。
 * @param props.projectActionError - 项目操作错误文案。
 * @param props.projectHref - 生成项目卡片跳转地址的回调。
 * @param props.projectIconName - 项目封面图标名称。
 * @param props.projects - 当前分组下可展示的项目。
 * @param props.renamingProjectIds - 正在重命名的项目 id 集合。
 * @returns 首页项目网格面板。
 */
function WorkspaceProjectsPanel({
  isCreatingProject,
  isLoading,
  loadingSkeletonIds,
  onCreateProject,
  onRenameProject,
  projectAriaLabelPrefix,
  projectActionError,
  projectHref,
  projectIconName,
  projects,
  renamingProjectIds,
}: WorkspaceProjectsPanelProps) {
  return (
    <div>
      {projectActionError ? (
        <div
          role="alert"
          className="mb-5 rounded-lg border border-danger-border bg-danger-bg px-4 py-3 text-body-sm leading-[1.5] text-danger-text"
        >
          {projectActionError}
        </div>
      ) : null}

      <ProjectGridViewport>
        {onCreateProject ? (
          <CreateProjectCard disabled={isCreatingProject} onCreateProject={onCreateProject} />
        ) : null}

        {isLoading
          ? loadingSkeletonIds.map((id) => (
              <article key={id} className="home-project-card animate-pulse">
                <span className="home-project-cover block" />
                <span className="mt-3 block h-5 w-32 rounded-full bg-[var(--home-surface-muted)]" />
                <span className="mt-2 block h-4 w-24 rounded-full bg-[var(--home-surface-muted)]" />
              </article>
            ))
          : projects.map((project) => (
              <WorkspaceProjectCard
                key={project.id}
                isRenaming={renamingProjectIds.has(project.id)}
                project={project}
                projectAriaLabelPrefix={projectAriaLabelPrefix}
                projectHref={projectHref(project)}
                projectIconName={projectIconName}
                onRenameProject={onRenameProject}
              />
            ))}
      </ProjectGridViewport>
    </div>
  )
}

type ProjectPanelProps = Omit<
  WorkspaceProjectsPanelProps,
  'loadingSkeletonIds' | 'projectAriaLabelPrefix' | 'projectHref' | 'projectIconName'
>

function CreateProjectCard({
  disabled,
  onCreateProject,
}: {
  disabled: boolean
  onCreateProject: () => void
}) {
  return (
    <button
      type="button"
      className="home-project-card home-project-card--new text-left disabled:cursor-wait disabled:opacity-60"
      disabled={disabled}
      onClick={onCreateProject}
    >
      <ProjectAddCover />
      <ProjectCardMeta title="New project" />
    </button>
  )
}

/**
 * 渲染首页项目卡片，封面打开项目，标题支持就地重命名。
 *
 * @param props - 项目卡片属性。
 * @param props.isRenaming - 当前项目是否正在提交重命名。
 * @param props.onRenameProject - 保存项目新名称的回调。
 * @param props.projectAriaLabelPrefix - 打开动作的项目类型前缀。
 * @param props.project - 首页项目摘要。
 * @param props.projectHref - 项目卡片封面跳转地址。
 * @param props.projectIconName - 项目封面图标名称。
 * @returns 可打开和重命名的项目卡片。
 */
function WorkspaceProjectCard({
  isRenaming,
  onRenameProject,
  projectAriaLabelPrefix,
  project,
  projectHref,
  projectIconName,
}: {
  isRenaming: boolean
  onRenameProject: (projectId: string, title: string) => Promise<boolean>
  projectAriaLabelPrefix: string
  project: RecentProjectItem
  projectHref: string
  projectIconName: HippoIconName
}) {
  return (
    <article className="home-project-card">
      <Link
        to={projectHref}
        className="home-project-card-cover-link"
        aria-label={`打开 ${projectAriaLabelPrefix} 项目 ${project.title}`}
      >
        <ProjectCover iconName={projectIconName} />
      </Link>
      <EditableProjectCardMeta
        isRenaming={isRenaming}
        project={project}
        updatedAt={project.updatedAt}
        onRenameProject={onRenameProject}
      />
    </article>
  )
}

/**
 * 渲染可编辑的项目卡片元信息。
 *
 * @param props - 项目卡片元信息属性。
 * @param props.isRenaming - 当前项目是否正在提交重命名。
 * @param props.onRenameProject - 保存项目新名称的回调。
 * @param props.project - 首页项目摘要。
 * @param props.updatedAt - 项目更新时间文案。
 * @returns 项目标题编辑区和更新时间。
 */
function EditableProjectCardMeta({
  isRenaming,
  onRenameProject,
  project,
  updatedAt,
}: {
  isRenaming: boolean
  onRenameProject: (projectId: string, title: string) => Promise<boolean>
  project: RecentProjectItem
  updatedAt: string
}) {
  const [draftTitle, setDraftTitle] = useState(project.title)
  const [isEditing, setIsEditing] = useState(false)
  const [isMenuOpen, setIsMenuOpen] = useState(false)
  const [menuAnchorRect, setMenuAnchorRect] = useState<DOMRect | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const menuButtonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!isEditing) {
      setDraftTitle(project.title)
    }
  }, [isEditing, project.title])

  useEffect(() => {
    if (isEditing) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [isEditing])

  /**
   * 进入项目名称编辑态。
   *
   * @returns 无返回值。
   */
  const startEditing = () => {
    setDraftTitle(project.title)
    setIsMenuOpen(false)
    setIsEditing(true)
  }

  /**
   * 放弃本次项目名称编辑。
   *
   * @returns 无返回值。
   */
  const cancelEditing = () => {
    setDraftTitle(project.title)
    setIsEditing(false)
  }

  /**
   * 同步输入框中的项目名称草稿。
   *
   * @param event - 输入框变更事件。
   * @returns 无返回值。
   */
  const handleTitleChange = (event: ChangeEvent<HTMLInputElement>) => {
    setDraftTitle(event.currentTarget.value)
  }

  /**
   * 提交项目名称修改。
   *
   * @returns 无返回值。
   */
  const submitRename = async () => {
    const nextTitle = draftTitle.trim()

    if (nextTitle === project.title.trim()) {
      cancelEditing()
      return
    }

    const didRename = await onRenameProject(project.id, nextTitle)

    if (didRename) {
      setIsEditing(false)
    }
  }

  /**
   * 处理项目名称输入框键盘提交和取消。
   *
   * @param event - 输入框键盘事件。
   * @returns 无返回值。
   */
  const handleTitleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      void submitRename()
      return
    }

    if (event.key === 'Escape') {
      event.preventDefault()
      cancelEditing()
    }
  }

  /**
   * 打开或关闭项目管理菜单。
   *
   * @returns 无返回值。
   */
  const toggleMenu = () => {
    const nextOpen = !isMenuOpen
    const anchorRect = menuButtonRef.current?.getBoundingClientRect() ?? null

    setMenuAnchorRect(nextOpen && anchorRect ? createLiftedProjectMenuAnchorRect(anchorRect) : null)
    setIsMenuOpen(nextOpen)
  }

  return (
    <span
      className={cn(
        'home-project-card-meta home-project-card-meta--managed',
        !isEditing ? 'home-project-card-meta--menuable' : '',
      )}
      data-menu-open={isMenuOpen ? 'true' : undefined}
    >
      <span className="home-project-card-meta-copy">
        {isEditing ? (
          <input
            ref={inputRef}
            aria-label={`修改项目名称：${project.title}`}
            className="home-project-card-title-input"
            disabled={isRenaming}
            maxLength={PROJECT_TITLE_MAX_LENGTH}
            type="text"
            value={draftTitle}
            onBlur={() => {
              void submitRename()
            }}
            onChange={handleTitleChange}
            onKeyDown={handleTitleKeyDown}
          />
        ) : (
          <span className="home-project-card-title" title={project.title}>
            {project.title}
          </span>
        )}
        <span className="home-project-card-time">{updatedAt}</span>
      </span>
      {!isEditing ? (
        <button
          ref={menuButtonRef}
          type="button"
          aria-expanded={isMenuOpen}
          aria-haspopup="menu"
          aria-label={`项目操作：${project.title}`}
          className="home-project-card-menu-button"
          disabled={isRenaming}
          onClick={toggleMenu}
        >
          <HippoIcon className="home-project-card-menu-icon" name="more" size={28} />
        </button>
      ) : null}
      <PopupContent
        align="top-start"
        anchorRect={menuAnchorRect}
        className="home-project-card-menu"
        open={isMenuOpen}
        role="menu"
        onDismiss={() => setIsMenuOpen(false)}
      >
        <button
          type="button"
          className="home-project-card-menu-item"
          role="menuitem"
          onClick={startEditing}
        >
          <HippoIcon
            className="home-project-card-menu-action-icon"
            name="edit-underline"
            size={20}
          />
          <span>Rename</span>
        </button>
      </PopupContent>
    </span>
  )
}

function ProjectCardMeta({ title, updatedAt }: { title: string; updatedAt?: string }) {
  return (
    <span className="home-project-card-meta">
      <span className="home-project-card-meta-copy">
        <span className="home-project-card-title">{title}</span>
        {updatedAt ? <span className="home-project-card-time">{updatedAt}</span> : null}
      </span>
    </span>
  )
}

/**
 * 渲染首页项目卡统一使用的加号封面。
 *
 * @returns 项目新增入口的封面结构。
 */
function ProjectAddCover() {
  return (
    <span className="home-new-project-cover">
      <span className="home-new-project-action" aria-hidden="true">
        <HippoIcon name="create-add-batch" size={42} />
      </span>
    </span>
  )
}

function ProjectCover({ iconName }: { iconName: HippoIconName }) {
  return (
    <span className="home-project-cover block" aria-hidden="true">
      <span className="home-project-cover-icon">
        <HippoIcon name={iconName} size={34} />
      </span>
    </span>
  )
}

function ProjectGridViewport({ children }: { children: ReactNode }) {
  return (
    <div className="home-project-grid-viewport">
      <div className="home-project-grid">{children}</div>
    </div>
  )
}
