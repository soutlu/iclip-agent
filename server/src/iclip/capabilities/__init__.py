"""Agent 能力适配层，连接 harness 与领域服务，业务规则由 domains 持有。

能力之间不直接依赖；共享设施通过平台协议注入，组合根统一提供实例。
能力名称登记在 app/capability_table.py。"""
