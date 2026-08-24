"""业务能力包的名字表：``agents.yaml`` 写名字，这里持有实现。

与 ``config.yaml`` 的 ``models`` 段同一个套路——声明面只出现名字，实现由代码
持有，组合根做翻译。能力包必须在代码里装，不能写进 agent spec：一个包带着函
数（工具、指令函数），YAML 表达不出来，官方也刻意不给这类 capability 序列化名。

表放在组合根而不是 ``capabilities/``，是因为包里的工具迟早要调 domain 的服务，
而只有这里能同时看见 domains 与 capabilities。届时用闭包把服务注入进工厂：

    PACKS = {"video": lambda: video_capability(shots=shots_service)}
"""

from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence

from iclip.harness.agents import AgentCapabilities

PackFactory = Callable[[], AgentCapabilities]
"""造一个能力包：返回它要往 agent 上挂的那几件能力。"""

PACKS: Mapping[str, PackFactory] = {}
"""已注册的业务能力包。落地一个包就在这里登记一个名字。"""


def resolve_packs(names: Sequence[str], *, declared_by: str) -> AgentCapabilities:
    """按名字取能力包；名字没登记即报错（装配期 fail fast）。"""

    resolved: AgentCapabilities = ()
    for name in names:
        factory = PACKS.get(name)
        if factory is None:
            known = ", ".join(PACKS) or "（还没有登记任何能力包）"
            raise RuntimeError(f"{declared_by} 引用了未登记的能力包 {name!r}；已登记的有: {known}")
        resolved = (*resolved, *factory())
    return resolved


__all__ = ["PACKS", "PackFactory", "resolve_packs"]
