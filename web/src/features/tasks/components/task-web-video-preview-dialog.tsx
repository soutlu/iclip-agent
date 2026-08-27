import { Dialog } from 'radix-ui'
import type {
  WebInspirationCandidate,
  WebInspirationPlatform,
} from '@/features/tasks/api/inspiration.api'
import { Icon } from '@/shared/icons'
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
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) {
          onClose()
        }
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="home-task-web-preview-overlay layer-popup" />
        <Dialog.Content
          aria-label={`${previewTitle} 预览`}
          className="home-task-web-preview-dialog layer-popup"
          data-platform={candidate.platform}
          onOpenAutoFocus={(event) => event.preventDefault()}
        >
          <header>
            <div>
              <span>{platformLabel}</span>
              <Dialog.Title>{previewTitle}</Dialog.Title>
              {candidate.creatorHandle ? <p>{candidate.creatorHandle}</p> : null}
            </div>
            <Dialog.Close aria-label="关闭联网视频预览" type="button">
              <Icon decorative name="close" size="md" />
            </Dialog.Close>
          </header>

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

          <footer>
            <span>
              原始返回第 {candidate.responsePosition} 位
              {candidate.durationSeconds ? ` · ${Math.round(candidate.durationSeconds)} 秒` : ''}
            </span>
            <a href={candidate.postUrl} rel="noopener noreferrer" target="_blank">
              打开原帖
              <Icon decorative name="external" size="sm" />
            </a>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
