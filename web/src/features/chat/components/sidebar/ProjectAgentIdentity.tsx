export const PROJECT_AGENT_KIND = {
  CreativeDirector: 'creative-director',
  Editor: 'editor',
  Producer: 'producer',
  Storyboard: 'storyboard',
} as const

export type ProjectAgentKind = (typeof PROJECT_AGENT_KIND)[keyof typeof PROJECT_AGENT_KIND]
export type ProjectAgentActivity = 'answering' | 'thinking'

export type ProjectAgentIdentityProps = {
  activity?: ProjectAgentActivity
  agent: ProjectAgentKind
  responding?: boolean
}

export const PROJECT_AGENT_ACTIVITY_LABELS: Record<ProjectAgentActivity, string> = {
  answering: '正在回答',
  thinking: '正在思考',
}

export const PROJECT_AGENT_DEFINITIONS = {
  [PROJECT_AGENT_KIND.CreativeDirector]: {
    avatarSrc: '/agent-icons/editor.png',
    label: '创意策划师',
  },
  [PROJECT_AGENT_KIND.Editor]: {
    avatarSrc: '/agent-icons/editor.png',
    label: '首席编辑',
  },
  [PROJECT_AGENT_KIND.Producer]: {
    avatarSrc: '/agent-icons/producer.png',
    label: '制片人',
  },
  [PROJECT_AGENT_KIND.Storyboard]: {
    avatarSrc: '/agent-icons/storyboard.png',
    label: '分镜执行导演',
  },
} as const

export type ProjectAgentDefinition = (typeof PROJECT_AGENT_DEFINITIONS)[ProjectAgentKind]

/**
 * 渲染项目 Agent 头像。
 *
 * @param props - Agent 头像属性。
 * @param props.definition - 当前 Agent 的头像和名称定义。
 * @returns 固定尺寸的 Agent 头像元素。
 */
export const ProjectAgentAvatar = ({ definition }: { definition: ProjectAgentDefinition }) => (
  <span className="grid h-8 w-8 shrink-0 place-items-center overflow-hidden rounded-full border border-chat-agent-avatar-border bg-chat-agent-avatar-bg shadow-[var(--shadow-chat-agent-avatar)]">
    <img
      alt={`${definition.label} Agent 头像`}
      className="h-full w-full rounded-full object-cover"
      height={32}
      src={definition.avatarSrc}
      width={32}
    />
  </span>
)

/**
 * 渲染项目时间线中的 Agent 身份牌。
 *
 * @param props - Agent 身份牌属性。
 * @param props.activity - 当前 Agent 的即时运行状态。
 * @param props.agent - 需要展示的本地 Agent 类型。
 * @param props.responding - 正在回答状态的布尔快捷参数。
 * @returns 展示头像、角色名称和运行状态的 Agent 标识。
 */
export const ProjectAgentIdentity = ({
  activity,
  agent,
  responding = false,
}: ProjectAgentIdentityProps) => {
  const definition = PROJECT_AGENT_DEFINITIONS[agent]
  const activeActivity = activity ?? (responding ? 'answering' : undefined)
  const identityClassName = activeActivity
    ? 'inline-flex min-w-0 items-center gap-2'
    : 'inline-flex h-8 max-w-full min-w-0 items-center gap-2 rounded-full bg-chat-agent-identity-bg py-0.5 pl-0.5 pr-3'

  return (
    <div className={identityClassName} data-agent-kind={agent}>
      <ProjectAgentAvatar definition={definition} />
      {activeActivity ? (
        <ProjectAgentActivityIndicator activity={activeActivity} />
      ) : (
        <span className="truncate text-body-sm leading-none font-semibold tracking-[0] text-chat-agent-identity-text">
          {definition.label}
        </span>
      )}
    </div>
  )
}

/**
 * 渲染 Agent 即时运行状态的轻量动态提示。
 *
 * @param props - 运行状态提示属性。
 * @param props.activity - 当前 Agent 的即时运行状态。
 * @returns 包含可见文案和跳动圆点的运行状态提示。
 */
export const ProjectAgentActivityIndicator = ({ activity }: { activity: ProjectAgentActivity }) => {
  const label = PROJECT_AGENT_ACTIVITY_LABELS[activity]

  return (
    <span
      aria-label={label}
      className="inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full bg-chat-tool-bg px-2.5"
      role="status"
    >
      <span className="text-caption leading-none font-medium tracking-[0] text-chat-muted-text">
        {label}
      </span>
      <span aria-hidden="true" className="inline-flex items-center gap-1">
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-chat-status-running [animation-delay:0ms]" />
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-chat-status-running [animation-delay:120ms]" />
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-chat-status-running [animation-delay:240ms]" />
      </span>
    </span>
  )
}
