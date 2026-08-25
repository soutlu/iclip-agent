"""capability 实现。

唯一同时认识 harness 与 domains 的适配环：每件业务能力 = 一个 capability 包
（instructions + 类型化 toolsets），领域逻辑本体留在 domains，包只是薄壳。

一件能力一个子目录，文件名按仓里既有的平名风格（不用上游库那种下划线私有名）：
``capability.py`` 放能力本体与工具集，``ports.py`` 放这个包对外要的窄协议，
``infra_sql.py`` 放这个包自有的 SQL（围栏只认这个文件名）。包名登记在
``app/capability_table.py``。

**能力包之间互不 import。** 两件能力要用同一样东西（比如都往同一个工作区落文
件），那样东西就下沉到 ``platform/`` 做成协议，两边各在构造器里收一份——组合根
把同一个实例递给两边。不在工具里去 ``ctx.capabilities`` 认领兄弟能力：那等于把
兄弟的内部形状写进自己的协议里。
"""
