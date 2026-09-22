import { frameJobKey } from '../frame-status'
import { FrameImageEditor } from '../image-edit/frame-image-editor'
import type { FrameEditTarget } from '../image-edit/image-edit-types'
import { isRunningStatus } from '../shots'
import type { GenerationJob } from '../storyboard.api'
import { frameEditTriggerSelector } from './frame-edit-trigger'

/** 打开图片编辑器的这一次：改哪一帧、先选中哪条结果、从哪个控件点开（关掉后焦点回它）。
 *
 * target 本身不带图，应用之后这一格换了图它也不用变。 */
export type FrameEditSession = {
  target: FrameEditTarget
  initialKey?: string | undefined
  trigger: HTMLElement | null
}

type Props = {
  session: FrameEditSession
  frames: readonly string[]
  aspectRatio: string
  /** 各帧最新的图片任务，按 `frameJobKey` 取；关掉时把这一帧落定的那条交回去标成看过。 */
  latestFrameJobs: ReadonlyMap<string, GenerationJob>
  onClose: (seen: GenerationJob | undefined) => void
  onApply: (previousUrl: string, url: string) => Promise<void>
}

/** 阅读器里挂图片编辑器：接线之外只管一件事，关掉后焦点回到点开它的地方。 */
export function ReaderImageEdit({
  session,
  frames,
  aspectRatio,
  latestFrameJobs,
  onClose,
  onApply,
}: Props) {
  const { target } = session
  return (
    <FrameImageEditor
      key={JSON.stringify(target)}
      target={target}
      frames={frames}
      aspectRatio={aspectRatio}
      initialKey={session.initialKey}
      onClose={() => {
        const latest = latestFrameJobs.get(frameJobKey(target.shotIndex, target.frameNumber))
        // 还在跑的那条不算看过，落定后照样要在帧上冒出来。
        onClose(latest !== undefined && !isRunningStatus(latest.status) ? latest : undefined)
        requestAnimationFrame(() => {
          const trigger = session.trigger
          if (trigger?.isConnected) trigger.focus()
          // 从「有新结果」角标点开的，关掉时角标已经清掉，焦点退回这一帧的编辑入口。
          else
            window.document
              .querySelector<HTMLElement>(frameEditTriggerSelector(target.shotIndex))
              ?.focus()
        })
      }}
      onApply={onApply}
    />
  )
}
