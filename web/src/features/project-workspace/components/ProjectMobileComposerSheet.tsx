import type { ReactNode } from 'react'
import { PROJECT_PAGE_LAYOUT } from '@/features/project-workspace/utils/project-page.constants'
import BottomSheet from '@/shared/ui/sheet/BottomSheet'

interface ProjectMobileComposerSheetProps {
  children: ReactNode
  title: string
}

export default function ProjectMobileComposerSheet({
  children,
  title,
}: ProjectMobileComposerSheetProps) {
  return (
    <BottomSheet
      snapHeights={PROJECT_PAGE_LAYOUT.mobileComposerHeights}
      handle={<SheetHandle title={title} />}
    >
      {children}
    </BottomSheet>
  )
}

function SheetHandle({ title }: { title: string }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col items-center">
      <div
        className="mb-2 h-1 w-12 rounded-full"
        style={{ backgroundColor: 'var(--color-on-surface-variant)', opacity: 0.6 }}
      />
      <div className="flex w-full items-center justify-start">
        <h3 className="text-sm font-medium text-[var(--color-on-background)]">{title}</h3>
      </div>
    </div>
  )
}
