export type StoryboardShotVideoPromptStatus = 'failed' | 'succeeded'
export type StoryboardShotVideoStatus = 'failed' | 'succeeded'
export type StoryboardShotStatus = 'failed'

export interface StoryboardShot {
  error?: string
  id?: string
  imageUrls?: string[]
  shotStatus?: StoryboardShotStatus
  storyline?: string
  structureLevel?: string
  videoError?: string
  videoPrompt?: string
  videoPromptError?: string
  videoPromptStatus?: StoryboardShotVideoPromptStatus
  videoStatus?: StoryboardShotVideoStatus
  videoTaskId?: string
  videoUrl?: string
}

export interface StoryboardOutput {
  shotTable?: StoryboardShot[]
}
