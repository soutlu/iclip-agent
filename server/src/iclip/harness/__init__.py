"""通用 agent 内核（M1 起构建）。

本环不认识任何业务概念；``pydantic_ai`` / ``pydantic_ai_harness`` 只准
出现在这里（后者仅限本环，经再导出供 capabilities 使用）。
六接缝（RunTarget / CapabilityContract / ConversationStore / RunLedger /
EventJournal / Policy 执法层）随首个实现落地，不预写抽象。
"""
