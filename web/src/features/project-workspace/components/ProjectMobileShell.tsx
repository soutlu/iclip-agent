import { ProjectChatComposer, ProjectChatPanel } from '@/features/chat'
import ProjectMobileComposerSheet from '@/features/project-workspace/components/ProjectMobileComposerSheet'

export default function ProjectMobileShell() {
  return (
    <div className="relative flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      <div className="min-h-0 flex-1 px-[var(--layout-project-stage-padding)] pt-[calc(var(--layout-project-header-height)+var(--layout-project-stage-padding))] pb-20">
        <ProjectChatPanel className="h-full" />
      </div>

      <ProjectMobileComposerSheet title="Edit with AI">
        <div className="flex w-full flex-col items-center">
          <ProjectChatComposer />
        </div>
      </ProjectMobileComposerSheet>
    </div>
  )
}
