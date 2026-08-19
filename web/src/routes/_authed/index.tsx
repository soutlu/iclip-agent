import { createFileRoute } from '@tanstack/react-router'
import { HomeRoute } from '@/features/home'

export const Route = createFileRoute('/_authed/')({
  component: HomeRoute,
})
