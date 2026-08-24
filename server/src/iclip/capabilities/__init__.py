"""capability 实现。

唯一同时认识 harness 与 domains 的适配环：每件业务能力 = 一个 capability 包
（instructions + 类型化 toolsets），领域逻辑本体留在 domains，包只是薄壳。

一件能力一个子目录，文件名按仓里既有的平名风格（不用上游库那种下划线私有名）：
``store.py`` 放存储契约与纯逻辑，``capability.py`` 放能力本体与工具集，
``infra_sql.py`` 放这个包自有的 SQL（围栏只认这个文件名）。包名登记在
``app/capability_table.py``。
"""
