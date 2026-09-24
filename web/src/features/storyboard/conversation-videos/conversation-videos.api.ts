import { useQuery } from '@tanstack/react-query'
import { conversationVideoJobsQuery } from '../storyboard.api'
import { groupConversationVideos } from './video-groups'

/** 与分镜页共用同一份完整视频记录，这里只投影成按镜头组分好的成片。 */
export const useConversationVideos = (conversationId: string) =>
  useQuery({ ...conversationVideoJobsQuery(conversationId), select: groupConversationVideos })
