"""业务能力包注册处（M2 起构建）。

唯一同时认识 harness 与 domains 的适配环：每个业务能力块 = 一个
Capability 包（instructions + toolsets + 可选 SKILL.md），领域逻辑
本体留在 domains，包只是薄壳。横切 policy（账本资格 / 授权 / 审计）
不进能力包，由 harness 在装配时统一执法。
"""
