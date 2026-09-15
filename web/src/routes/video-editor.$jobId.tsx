import { createFileRoute } from '@tanstack/react-router'
import { VideoEditorPage } from '@/features/storyboard'

export const Route = createFileRoute('/video-editor/$jobId')({
  component: VideoEditorRoute,
})

function VideoEditorRoute() {
  const { jobId } = Route.useParams()
  return <VideoEditorPage jobId={jobId} />
}
