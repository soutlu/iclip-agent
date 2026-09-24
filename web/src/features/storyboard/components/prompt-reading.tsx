import { Button } from '@/shared/ui/button'
import type { LightboxMedia } from '@/shared/ui/media-lightbox'
import { encodeContentId, updateContentPrompt } from '../shot-content'
import { formatShotPrompt, type Shot } from '../shot-document'
import { aspectRatioStyle } from '../shots'
import { copyWithToast } from './copy-with-toast'
import { PromptEditor } from './prompt-editor'

type PromptReadingProps = {
  shot: Shot
  aspect_ratio: string
  onClose: () => void
  onPreview: (media: LightboxMedia) => void
  onUpdateShot: (updater: (current: Shot) => Shot) => void
  readOnly: boolean
}

/** 「镜头组完整提示词」抽屉：全组一次展开，每段正文各自写回，右侧列本组参考图。 */
export function PromptReading({
  aspect_ratio,
  onClose,
  onPreview,
  onUpdateShot,
  readOnly,
  shot,
}: PromptReadingProps) {
  // 写入路径与单页视图共用 updateContentPrompt。
  const changePrompt = (id: string) => (text: string) =>
    onUpdateShot((current) => updateContentPrompt(current, id, text))
  const previewFrame = (number: number) => {
    const url = shot.image_urls[number - 1]
    if (url !== undefined) onPreview({ kind: 'image', name: `参考图 @Image${number}`, url })
  }
  return (
    <>
      <header className="flex shrink-0 items-center justify-between gap-3 border-b-[0.5px] border-chat-hairline px-5 py-4">
        <div>
          <h3 className="text-body font-medium text-on-surface">
            镜头组 {shot.index} · 完整提示词
          </h3>
          <p className="mt-1 text-body-sm text-on-surface-faint">
            {shot.seconds} 秒 · {aspect_ratio} · {shot.image_urls.length} 张参考图
          </p>
        </div>
        <Button
          aria-label="收起完整提示词"
          onClick={onClose}
          size="md"
          trailingIcon="expand"
          variant="ghost"
        >
          收起
        </Button>
      </header>
      <div className="group-prompt-body min-h-0 flex-1">
        <div
          aria-label="镜头组原文"
          className="group-prompt-reading min-h-0 min-w-0 space-y-5 overflow-y-auto overscroll-contain p-5 ui-focus-inline"
          data-reader-focus
          role="region"
          tabIndex={-1}
        >
          <PromptEditor
            aria-label="全局设定"
            frames={shot.image_urls}
            onChange={changePrompt(encodeContentId({ kind: 'global' }))}
            readOnly={readOnly}
            value={shot.prompt.global_settings}
            onPickFrame={previewFrame}
          />
          {shot.prompt.timeline.map((item, index) => (
            <section aria-label={`镜头 ${index + 1} 原文`} key={item.timestamps.join(':')}>
              <h4 className="mb-2 text-label text-on-surface-faint">
                [{item.timestamps[0]}–{item.timestamps[1]}秒｜镜头{index + 1}]
              </h4>
              <PromptEditor
                aria-label={`镜头 ${index + 1} 的描述`}
                frames={shot.image_urls}
                onChange={changePrompt(encodeContentId({ kind: 'scene', scene: index + 1 }))}
                onPickFrame={previewFrame}
                readOnly={readOnly}
                value={item.prompt}
              />
            </section>
          ))}
        </div>
        <section
          aria-label="本组参考图"
          className="group-prompt-references min-h-0 min-w-0 overflow-y-auto overscroll-contain border-l-[0.5px] border-chat-hairline p-4"
        >
          <h4 className="mb-3 text-body-sm font-medium text-on-surface-variant">
            参考图 · {shot.image_urls.length} 张
          </h4>
          {shot.image_urls.length === 0 ? (
            <p className="text-body-sm text-on-surface-faint">本组暂无参考图</p>
          ) : (
            <div className="grid grid-cols-2 items-start gap-x-3 gap-y-4">
              {shot.image_urls
                .map((url, index) => ({ url, number: index + 1 }))
                .map(({ url, number }) => (
                  <figure className="min-w-0" key={number}>
                    <button
                      aria-label={`查看参考图 @Image${number}`}
                      className="block w-full cursor-zoom-in overflow-hidden rounded-xs bg-surface-container ui-focus"
                      onClick={() =>
                        onPreview({ kind: 'image', name: `参考图 @Image${number}`, url })
                      }
                      type="button"
                    >
                      <img
                        alt={`镜头组 ${shot.index} 参考图 @Image${number}`}
                        className="block w-full object-contain"
                        loading="lazy"
                        src={url}
                        style={{ aspectRatio: aspectRatioStyle(aspect_ratio) }}
                      />
                    </button>
                    <figcaption className="mt-1 text-caption text-on-surface-variant">
                      @Image{number}
                    </figcaption>
                  </figure>
                ))}
            </div>
          )}
        </section>
      </div>
      <footer className="flex shrink-0 justify-end border-t-[0.5px] border-chat-hairline px-5 py-3">
        <Button
          leadingIcon="copy"
          onClick={() => void copyWithToast(formatShotPrompt(shot), '已复制完整提示词')}
          size="md"
          variant="ghost"
        >
          复制完整提示词
        </Button>
      </footer>
    </>
  )
}
