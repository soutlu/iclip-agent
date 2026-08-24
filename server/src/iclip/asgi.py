"""ASGI 导出入口：``iclip.asgi:app``。

配置路径来自 ``CONFIG_FILE``，agent 装配声明来自 ``AGENTS_FILE``
（缺省 ``agents/agents.yaml``；文件不存在即启动失败，空注册表由 ``agent: {}`` 表达）。
"""

from __future__ import annotations

import os
from pathlib import Path

from iclip.app.bootstrap import build_app
from iclip.config import load_agent_declarations, load_runtime_config

_config_path = Path(os.environ.get("CONFIG_FILE", "configs/config.yaml"))
_agents_path = Path(os.environ.get("AGENTS_FILE", "agents/agents.yaml"))
app = build_app(
    load_runtime_config(_config_path),
    agents=load_agent_declarations(_agents_path),
)
