"""ASGI 导出入口：``iclip.asgi:app``。

配置路径来自 ``CONFIG_FILE``，agent 装配声明来自 ``AGENTS_FILE``
（缺省 ``agents/agents.yaml``；文件不存在即启动失败，空注册表由 ``agent: {}`` 表达）。

装配在 import 期完成且不建立任何连接，连接与后台循环都留给 lifespan。合同导出靠
的就是这一点：``scripts/dump_openapi.py`` 只 import 本模块取 OpenAPI，从不启动应用。

进程收到 SIGHUP 时从同样两个路径重读，热换模型表与 agent 层（见 app/agent_layer.py）。
"""

from __future__ import annotations

import os
from pathlib import Path

from iclip.app.bootstrap import build_app
from iclip.config import ResolvedAgent, RuntimeConfig, load_agent_declarations, load_runtime_config

_config_path = Path(os.environ.get("CONFIG_FILE", "configs/config.yaml"))
_agents_path = Path(os.environ.get("AGENTS_FILE", "agents/agents.yaml"))


def _load() -> tuple[RuntimeConfig, tuple[ResolvedAgent, ...]]:
    return load_runtime_config(_config_path), load_agent_declarations(_agents_path)


_config, _agents = _load()
app = build_app(_config, agents=_agents, reload_source=_load)
