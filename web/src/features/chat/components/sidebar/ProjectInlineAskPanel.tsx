import { useProjectChatActiveInterrupt } from '../../state/ProjectChatProvider'
import AskUserQuestionPanel from '../tools/AskUserQuestionPanel'

interface ProjectInlineAskPanelProps {
  className?: string
  targetId: string
}

/**
 * 在指定 timeline 位置展示 ask_user_question 内联面板。
 *
 * @param props - 内联 ask 面板属性。
 * @param props.className - 追加到工具面板容器上的样式类。
 * @param props.targetId - ask 工具调用 id。
 * @returns timeline item 匹配 active interrupt 时返回 ask 面板，否则不渲染。
 */
export default function ProjectInlineAskPanel({
  className = '',
  targetId,
}: ProjectInlineAskPanelProps) {
  const activeInterrupt = useProjectChatActiveInterrupt()

  if (activeInterrupt?.kind !== 'ask_user_question' || activeInterrupt.targetId !== targetId) {
    return null
  }

  return <AskUserQuestionPanel className={className} interrupt={activeInterrupt} />
}
