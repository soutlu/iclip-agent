import type {
  WebInspirationCandidate,
  WebInspirationPlatform,
} from '@/features/tasks/api/inspiration.api'
import { Icon } from '@/shared/icons'
import {
  DialogBody,
  DialogFooter,
  DialogHeader,
  DialogRoot,
  DialogSurface,
} from '@/shared/ui/dialog'
import {
  resolveWebInspirationEmbedUrl,
  webInspirationPlatformLabel,
} from './task-web-video-preview'

type PreviewCandidate = WebInspirationCandidate & { platform: WebInspirationPlatform }

type TaskWebVideoPreviewDialogProps = {
  candidate: PreviewCandidate
  onClose: () => void
}

/** 单条联网候选预览；一次只挂一个第三方 iframe，关闭即卸载播放器。 */
export default function TaskWebVideoPreviewDialog({
  candidate,
  onClose,
}: TaskWebVideoPreviewDialogProps) {
  const platformLabel = webInspirationPlatformLabel(candidate.platform)
  const previewTitle = candidate.title?.trim() || `${platformLabel} 联网视频`
  const origin =
    typeof globalThis.window === 'undefined'
      ? 'http://localhost'
      : globalThis.window.location.origin
  const embedUrl = resolveWebInspirationEmbedUrl(
    candidate.platform,
    candidate.platformVideoId,
    origin,
  )

  return (
    <DialogRoot
      open
      onOpenChange={(open) => {
        if (!open) {
          onClose()
        }
      }}
    >
      <DialogSurface
        aria-label={`${previewTitle} 预览`}
        data-platform={candidate.platform}
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <DialogHeader closeLabel="关闭联网视频预览" title={previewTitle}>
          <p className="mt-1 text-body-sm text-on-surface-variant">
            {platformLabel}
            {candidate.creatorHandle ? ` · ${candidate.creatorHandle}` : ''}
          </p>
        </DialogHeader>

        <DialogBody className="p-0">
          <div className="home-task-web-preview-stage">
            {embedUrl ? (
              <iframe
                allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
                allowFullScreen
                referrerPolicy="strict-origin-when-cross-origin"
                src={embedUrl}
                title={`${previewTitle} 播放器`}
              />
            ) : (
              <p>该平台暂不支持站内预览，请打开原帖查看。</p>
            )}
          </div>
        </DialogBody>

        <DialogFooter>
          <span>
            原始返回第 {candidate.responsePosition} 位
            {candidate.durationSeconds ? ` · ${Math.round(candidate.durationSeconds)} 秒` : ''}
          </span>
          <a
            className="inline-flex items-center gap-1.5 font-medium text-primary ui-focus"
            href={candidate.postUrl}
            rel="noopener noreferrer"
            target="_blank"
          >
            打开原帖
            <Icon decorative name="external" size="sm" />
          </a>
        </DialogFooter>
      </DialogSurface>
    </DialogRoot>
  )
}
