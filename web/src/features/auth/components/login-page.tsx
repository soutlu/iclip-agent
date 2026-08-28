import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { probeSsoLoginEnabled } from '@/shared/auth'
import { HeroAnimation } from '@/shared/ui/hero'
import { LoginForm } from './login-form'

// SSO 落地路由通过 ?ssoError= 传回的错误码 → 用户可读文案（SSO 通道即飞书登录）。
const SSO_ERROR_MESSAGES: Record<string, string> = {
  forbidden: '账号已停用，请联系管理员开通',
  invalid: '飞书登录会话无效或已过期，请重新登录',
  missing: '缺少飞书登录凭证，请重新发起登录',
  unavailable: '飞书登录暂不可用，请稍后重试或使用账号密码登录',
}

type LoginPageProps = {
  nextPath: string
  ssoErrorCode?: string | undefined
}

/**
 * 渲染 Producer 独立登录页。
 *
 * @param props - 登录页属性。
 * @param props.nextPath - 登录成功后的安全站内跳转路径。
 * @param props.ssoErrorCode - SSO 落地页回传的错误码。
 * @returns 登录页组件。
 */
export function LoginPage({ nextPath, ssoErrorCode }: LoginPageProps) {
  const ssoErrorMessage = ssoErrorCode
    ? (SSO_ERROR_MESSAGES[ssoErrorCode] ?? 'SSO 登录失败，请重试')
    : undefined
  // 探测后端是否开启企业 SSO，决定登录页是否展示 SSO 入口。
  const { data: ssoEnabled = false } = useQuery({
    queryFn: probeSsoLoginEnabled,
    queryKey: ['auth', 'sso-enabled'],
    staleTime: Number.POSITIVE_INFINITY,
  })

  return (
    <main className="producer-auth-page relative isolate min-h-dvh overflow-x-hidden text-on-background">
      <div className="producer-auth-bg-ambient absolute inset-[-18%] -z-10" aria-hidden="true" />
      <div className="producer-auth-bg-grid absolute inset-0 -z-10" aria-hidden="true" />

      <div className="flex min-h-dvh flex-col px-5 py-5 sm:px-8 md:px-12 md:py-7">
        <header className="layer-header flex h-12 shrink-0 items-start">
          <Link to="/" aria-label="返回 Producer 首页" className="producer-auth-brand-link">
            Producer
          </Link>
        </header>

        <section className="grid min-h-0 flex-1 grid-cols-1 items-center gap-8 py-8 sm:py-10 lg:grid-cols-[minmax(0,1fr)_minmax(420px,560px)] lg:gap-16 lg:px-6 lg:pt-0 lg:pb-16">
          {/* 插画只在展开断点出现：窄屏留给表单，冷启动也不必为装饰下载 370KB */}
          <div className="hidden lg:flex lg:justify-center">
            <HeroAnimation className="producer-auth-hero w-[min(620px,46vw)]" />
          </div>

          <div className="producer-auth-panel-shell mx-auto w-full max-w-[560px] lg:mr-[1vw]">
            <div className="producer-auth-panel-card">
              <p className="producer-auth-kicker mb-5 text-body-sm font-bold tracking-[0.28em] uppercase">
                Agent Producer
              </p>
              <h1 className="producer-auth-title mb-3 text-display-sm leading-none font-bold sm:text-display">
                欢迎回来
              </h1>
              <p className="producer-auth-subtitle mb-9 text-body">登录以继续你的 AI 视频创作</p>

              <LoginForm
                nextPath={nextPath}
                ssoEnabled={ssoEnabled}
                initialErrorMessage={ssoErrorMessage}
              />
            </div>
          </div>
        </section>
      </div>
    </main>
  )
}
