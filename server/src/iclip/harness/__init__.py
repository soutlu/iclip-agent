"""通用 agent 内核。

本环不认识任何业务概念。``pydantic_ai_harness`` 只准出现在这里，要给
capabilities 用就经本环再导出；``pydantic_ai`` 本身两环都可以直接 import
（围栏以架构测试为准）。
接口随首个实现落地，不预写抽象。
"""
