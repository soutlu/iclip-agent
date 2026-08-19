"""ASGI 导出入口：``iclip.asgi:app``，配置路径来自 ``ICLIP_CONFIG_FILE``。"""

from __future__ import annotations

import os
from pathlib import Path

from iclip.app.bootstrap import build_app
from iclip.config import load_runtime_config

_config_path = Path(os.environ.get("ICLIP_CONFIG_FILE", "configs/config.yaml"))
app = build_app(load_runtime_config(_config_path))
