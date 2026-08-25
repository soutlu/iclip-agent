import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Clapperboard, Database, Play, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import {
  inspirationVideoSelectionKey,
  type SelectedInspirationVideo,
} from '@/features/tasks/api/inspiration.api'
import {
  updateVideoTaskConfirmation,
  VIDEO_TASKS_QUERY_KEY,
} from '@/features/tasks/api/video-task.api'
import type { VideoTask, VideoTaskAsset } from '@/features/tasks/video-task.types'
import { MediaPreviewDialog, useMediaPreview } from '@/shared/ui/media'
import { assetPreviewFileName, handlePreviewKeyDown } from './task-display'
import TaskErpImagePickerDialog, { type PickedProductImage } from './task-erp-image-picker-dialog'
import TaskInspirationVideoPickerDialog from './task-inspiration-video-picker-dialog'
import { TaskMediaPicker } from './task-media-picker'
import TaskWebVideoPreviewDialog from './task-web-video-preview-dialog'
import { webInspirationPlatformLabel } from './task-web-video-preview'
import { taskMediaAttachmentsToFiles, useTaskMediaAttachments } from './use-task-media-attachments'
import type { TaskConfirmationDraft } from './use-task-confirmation-draft'

const removeUrl = (urls: string[], url: string) => urls.filter((item) => item !== url)
const MIN_TASK_DURATION_SECONDS = 3
const MAX_TASK_DURATION_SECONDS = 50

type TaskMaterialsEditorProps = {
  assetsById: Record<string, VideoTaskAsset>
  confirmation: TaskConfirmationDraft
  task: VideoTask
}

/**
 * 确认视角的创作材料编辑区：从产品图库多选参考图、接爆款库推荐参考视频（可选排序）、
 * 保留图片与视频的上传入口。产品图数量可能非常大：网格用源地址浏览，保存时只把
 * 选中的少量图片经后端按需转存 OSS，再登记为 import Asset 与上传素材一起写回任务的
 * referenceImages / referenceVideos。
 *
 * @param props - 任务与已解析素材索引。
 * @returns 可保存的创作材料编辑区。
 */
export default function TaskMaterialsEditor({
  assetsById,
  confirmation,
  task,
}: TaskMaterialsEditorProps) {
  const queryClient = useQueryClient()
  // 组件被父级以 `${task.id}:${task.updatedAt}` 作 key 强制重挂，以下派生值在生命周期内不变。
  const styleNos =
    task.brief.styleNos && task.brief.styleNos.length > 0
      ? task.brief.styleNos
      : [task.style.styleNo]
  const referencedImageAssets = task.brief.referenceImages
    .map((assetId) => assetsById[assetId])
    .filter((asset): asset is VideoTaskAsset => asset !== undefined)
  const referencedVideoAssets = task.brief.referenceVideos
    .map((assetId) => assetsById[assetId])
    .filter((asset): asset is VideoTaskAsset => asset !== undefined)
  const [keptImageUrls, setKeptImageUrls] = useState(() =>
    referencedImageAssets.map((asset) => asset.url),
  )
  const [pickedProductImages, setPickedProductImages] = useState<PickedProductImage[]>([])
  const [selectedVideoUrls, setSelectedVideoUrls] = useState(() =>
    referencedVideoAssets.map((asset) => asset.url),
  )
  const [selectedInspirationVideos, setSelectedInspirationVideos] = useState<
    SelectedInspirationVideo[]
  >([])
  const [erpPickerOpen, setErpPickerOpen] = useState(false)
  const [inspirationPickerOpen, setInspirationPickerOpen] = useState(false)
  const [previewWebCandidate, setPreviewWebCandidate] = useState<Extract<
    SelectedInspirationVideo,
    { source: 'web' }
  > | null>(null)
  const { closePreview, openPreview, preview } = useMediaPreview()
  const imageUploads = useTaskMediaAttachments('image')
  const videoUploads = useTaskMediaAttachments('video')

  const keptImageAssets = referencedImageAssets.filter((asset) => keptImageUrls.includes(asset.url))
  const keptVideoAssets = referencedVideoAssets.filter((asset) =>
    selectedVideoUrls.includes(asset.url),
  )
  const firstSelectedInspirationVideo = selectedInspirationVideos[0]
  const primaryVideoUrl =
    keptVideoAssets[0]?.url ??
    (firstSelectedInspirationVideo?.source === 'library'
      ? firstSelectedInspirationVideo.ossUrl
      : firstSelectedInspirationVideo === undefined
        ? videoUploads.attachments[0]?.url
        : undefined)
  const primaryWebDuration =
    keptVideoAssets.length === 0 &&
    firstSelectedInspirationVideo?.source === 'web' &&
    firstSelectedInspirationVideo.durationSeconds !== null &&
    firstSelectedInspirationVideo.durationSeconds >= MIN_TASK_DURATION_SECONDS &&
    firstSelectedInspirationVideo.durationSeconds <= MAX_TASK_DURATION_SECONDS
      ? firstSelectedInspirationVideo.durationSeconds
      : undefined
  const durationAwaitingMetadata =
    primaryVideoUrl !== undefined &&
    task.brief.durationSeconds === undefined &&
    !confirmation.detectedDuration &&
    !confirmation.durationManuallyEdited

  useEffect(() => {
    if (
      primaryWebDuration !== undefined &&
      task.brief.durationSeconds === undefined &&
      !confirmation.detectedDuration &&
      !confirmation.durationManuallyEdited
    ) {
      confirmation.detectDuration(primaryWebDuration)
    }
  }, [confirmation, primaryWebDuration, task.brief.durationSeconds])

  const recordVideoDuration = (url: string, duration: number) => {
    if (url === primaryVideoUrl) {
      confirmation.detectDuration(duration)
    }
  }

  // 既有素材只会被移除、不会新增，长度变短即视为有改动。
  const dirty =
    confirmation.dirty ||
    imageUploads.attachments.length > 0 ||
    videoUploads.attachments.length > 0 ||
    pickedProductImages.length > 0 ||
    selectedInspirationVideos.length > 0 ||
    keptImageUrls.length !== referencedImageAssets.length ||
    selectedVideoUrls.length !== referencedVideoAssets.length

  const saveMutation = useMutation({
    mutationFn: () =>
      updateVideoTaskConfirmation(task, {
        durationSeconds: confirmation.durationSeconds,
        inspirationVideos: selectedInspirationVideos.map((video) =>
          video.source === 'library'
            ? { ossUrl: video.ossUrl, source: 'library' as const }
            : { source: 'web' as const },
        ),
        keptImageUrls: keptImageAssets.map((asset) => asset.url),
        keptVideoUrls: selectedVideoUrls,
        newImageFiles: taskMediaAttachmentsToFiles(imageUploads.attachments),
        newVideoFiles: taskMediaAttachmentsToFiles(videoUploads.attachments),
        // 勾选的产品图交给 API 层逐张转存成我们自己的地址。
        productImageUrls: pickedProductImages.map((pick) => pick.url),
        ratio: confirmation.ratio.trim(),
        requirementDescription: confirmation.requirementDescription,
      }),
    onSuccess: async () => {
      setSelectedInspirationVideos([])
      await queryClient.invalidateQueries({ queryKey: VIDEO_TASKS_QUERY_KEY })
    },
  })

  const uploadsPending = imageUploads.pendingCount > 0 || videoUploads.pendingCount > 0

  return (
    <section aria-label="创作材料" className="home-task-materials">
      <div className="home-task-materials-block">
        <div className="home-task-materials-heading">
          <h4>参考图</h4>
          <span>可从 ERP 产品图库选择，也可上传补充图片</span>
          <button
            aria-haspopup="dialog"
            className="home-task-picker-trigger"
            data-testid="open-erp-image-picker"
            type="button"
            onClick={() => setErpPickerOpen(true)}
          >
            <Database aria-hidden="true" size={14} strokeWidth={2} />
            ERP图片
          </button>
        </div>

        <div aria-label="参考图列表" className="home-task-reference-image-rail" role="group">
          {keptImageAssets.map((asset) => {
            const label = `已有参考图 ${asset.id}`
            const openImagePreview = () => {
              openPreview({
                altText: '已有参考图',
                fileName: assetPreviewFileName(asset.url, label),
                mediaType: 'image',
                url: asset.url,
              })
            }

            return (
              <figure className="home-task-reference-image-item" key={asset.id}>
                <button
                  aria-label={`双击查看${label}`}
                  className="home-task-material-preview-trigger"
                  title="双击查看大图"
                  type="button"
                  onDoubleClick={openImagePreview}
                  onKeyDown={(event) => handlePreviewKeyDown(event, openImagePreview)}
                >
                  <img alt="已有参考图" className="media-natural-ratio" src={asset.url} />
                </button>
                <button
                  aria-label={`移除参考图 ${asset.id}`}
                  className="home-task-media-remove"
                  type="button"
                  onClick={() => setKeptImageUrls((urls) => removeUrl(urls, asset.url))}
                >
                  <X aria-hidden="true" size={10} strokeWidth={2} />
                </button>
              </figure>
            )
          })}
          {pickedProductImages.map((image) => {
            const label = `ERP参考图 ${image.id}`
            const openImagePreview = () => {
              openPreview({
                altText: label,
                fileName: assetPreviewFileName(image.url, label),
                mediaType: 'image',
                url: image.url,
              })
            }

            return (
              <figure
                className="home-task-reference-image-item"
                key={`${image.styleNo}-${image.id}`}
              >
                <button
                  aria-label={`双击查看${label}`}
                  className="home-task-material-preview-trigger"
                  title="双击查看大图"
                  type="button"
                  onDoubleClick={openImagePreview}
                  onKeyDown={(event) => handlePreviewKeyDown(event, openImagePreview)}
                >
                  <img alt={label} className="media-natural-ratio" src={image.url} />
                </button>
                <button
                  aria-label={`移除ERP参考图 ${image.id}`}
                  className="home-task-media-remove"
                  type="button"
                  onClick={() =>
                    setPickedProductImages((images) =>
                      images.filter((item) => item.url !== image.url),
                    )
                  }
                >
                  <X aria-hidden="true" size={10} strokeWidth={2} />
                </button>
              </figure>
            )
          })}
          <TaskMediaPicker
            attachments={imageUploads.attachments}
            errorMessage={imageUploads.errorMessage}
            kind="image"
            label="上传补充图片"
            layout="inline"
            pendingCount={imageUploads.pendingCount}
            onFilesSelected={imageUploads.ingest}
            onRemove={imageUploads.remove}
          />
        </div>
      </div>

      <div className="home-task-materials-block">
        <div className="home-task-materials-heading">
          <h4>参考视频</h4>
          <span>可从爆款库选择或联网搜索，也可上传视频</span>
          <button
            aria-haspopup="dialog"
            className="home-task-picker-trigger"
            data-testid="open-inspiration-video-picker"
            type="button"
            onClick={() => setInspirationPickerOpen(true)}
          >
            <Clapperboard aria-hidden="true" size={14} strokeWidth={2} />
            爆款视频
          </button>
        </div>

        <div aria-label="参考视频列表" className="home-task-reference-video-rail" role="group">
          {keptVideoAssets.map((asset) => {
            const label = `已有参考视频 ${asset.id}`
            const openVideoPreview = () => {
              openPreview({
                fileName: assetPreviewFileName(asset.url, label),
                mediaType: 'video',
                url: asset.url,
              })
            }

            return (
              <figure className="home-task-pending-media" key={asset.id}>
                <button
                  aria-label={`双击查看${label}`}
                  className="home-task-material-preview-trigger"
                  title="双击查看视频"
                  type="button"
                  onDoubleClick={openVideoPreview}
                  onKeyDown={(event) => handlePreviewKeyDown(event, openVideoPreview)}
                >
                  <video
                    aria-label="已有参考视频"
                    className="media-natural-ratio"
                    muted
                    playsInline
                    preload="metadata"
                    src={asset.url}
                    onLoadedMetadata={(event) =>
                      recordVideoDuration(asset.url, event.currentTarget.duration)
                    }
                  />
                </button>
                <button
                  aria-label={`移除参考视频 ${asset.id}`}
                  className="home-task-media-remove"
                  type="button"
                  onClick={() => setSelectedVideoUrls((urls) => removeUrl(urls, asset.url))}
                >
                  <X aria-hidden="true" size={10} strokeWidth={2} />
                </button>
              </figure>
            )
          })}
          {selectedInspirationVideos.map((video) => {
            const identity = inspirationVideoSelectionKey(video)
            const label =
              video.source === 'library'
                ? `新选参考视频 ${video.videoId}`
                : `联网参考视频 ${video.platform} 第 ${String(video.responsePosition)} 位`
            if (video.source === 'web') {
              return (
                <figure
                  className="home-task-pending-media home-task-web-pending-media"
                  key={identity}
                >
                  <button
                    aria-label={`预览${label}`}
                    className="home-task-material-preview-trigger"
                    title="预览联网视频"
                    type="button"
                    onClick={() => setPreviewWebCandidate(video)}
                  >
                    {video.thumbnailUrl ? (
                      <img
                        alt=""
                        className="media-natural-ratio"
                        referrerPolicy="no-referrer"
                        src={video.thumbnailUrl}
                      />
                    ) : (
                      <span className="home-task-web-pending-placeholder">
                        <Play aria-hidden="true" size={16} strokeWidth={2} />
                        <span>{webInspirationPlatformLabel(video.platform)}</span>
                      </span>
                    )}
                  </button>
                  <button
                    aria-label={`移除${label}`}
                    className="home-task-media-remove"
                    type="button"
                    onClick={() =>
                      setSelectedInspirationVideos((videos) =>
                        videos.filter((item) => inspirationVideoSelectionKey(item) !== identity),
                      )
                    }
                  >
                    <X aria-hidden="true" size={10} strokeWidth={2} />
                  </button>
                </figure>
              )
            }
            const openVideoPreview = () => {
              openPreview({
                fileName: assetPreviewFileName(video.ossUrl, label),
                mediaType: 'video',
                url: video.ossUrl,
              })
            }

            return (
              <figure className="home-task-pending-media" key={identity}>
                <button
                  aria-label={`双击查看${label}`}
                  className="home-task-material-preview-trigger"
                  title="双击查看视频"
                  type="button"
                  onDoubleClick={openVideoPreview}
                  onKeyDown={(event) => handlePreviewKeyDown(event, openVideoPreview)}
                >
                  <video
                    aria-label={label}
                    className="media-natural-ratio"
                    muted
                    playsInline
                    preload="metadata"
                    src={video.ossUrl}
                    onLoadedMetadata={(event) =>
                      recordVideoDuration(video.ossUrl, event.currentTarget.duration)
                    }
                  />
                </button>
                <button
                  aria-label={`移除${label}`}
                  className="home-task-media-remove"
                  type="button"
                  onClick={() =>
                    setSelectedInspirationVideos((videos) =>
                      videos.filter((item) => inspirationVideoSelectionKey(item) !== identity),
                    )
                  }
                >
                  <X aria-hidden="true" size={10} strokeWidth={2} />
                </button>
              </figure>
            )
          })}
          <TaskMediaPicker
            attachments={videoUploads.attachments}
            errorMessage={videoUploads.errorMessage}
            kind="video"
            label="上传参考视频"
            layout="inline"
            pendingCount={videoUploads.pendingCount}
            onFilesSelected={videoUploads.ingest}
            onVideoMetadata={recordVideoDuration}
            onRemove={videoUploads.remove}
          />
        </div>
      </div>

      <div className="home-task-materials-footer">
        {saveMutation.error ? (
          <p className="home-task-start-error" role="alert">
            {saveMutation.error.message}
          </p>
        ) : null}
        <button
          className="home-task-start-button"
          disabled={
            !dirty ||
            uploadsPending ||
            durationAwaitingMetadata ||
            confirmation.durationError !== undefined ||
            saveMutation.isPending
          }
          type="button"
          onClick={() => saveMutation.mutate()}
        >
          {saveMutation.isPending ? '正在保存…' : '保存创作材料'}
        </button>
      </div>

      {inspirationPickerOpen ? (
        <TaskInspirationVideoPickerDialog
          category={task.style.category}
          selectedVideos={selectedInspirationVideos}
          styleNos={styleNos}
          taskId={task.id}
          onChange={setSelectedInspirationVideos}
          onClose={() => setInspirationPickerOpen(false)}
        />
      ) : null}

      {erpPickerOpen ? (
        <TaskErpImagePickerDialog
          pickedImages={pickedProductImages}
          styleNos={styleNos}
          onChange={setPickedProductImages}
          onClose={() => setErpPickerOpen(false)}
          onPreview={openPreview}
        />
      ) : null}
      {previewWebCandidate ? (
        <TaskWebVideoPreviewDialog
          candidate={previewWebCandidate}
          onClose={() => setPreviewWebCandidate(null)}
        />
      ) : null}
      {preview ? <MediaPreviewDialog onClose={closePreview} preview={preview} /> : null}
    </section>
  )
}
