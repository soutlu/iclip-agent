"""外部 PDM 同步库的替身表结构。

``pdm_styles`` 被产品资料与爆款视频两处消费，DDL 只在这里声明一份。"""

from __future__ import annotations

from typing import Final

PDM_STYLES_DDL: Final = """
CREATE TABLE pdm_styles (
    pdm_entity_id       bigint PRIMARY KEY,
    product_number      varchar NOT NULL,
    style_wms           varchar,
    source_status       varchar NOT NULL,
    product_category_id bigint,
    attributes          json    NOT NULL DEFAULT '{}'::json,
    is_active           boolean NOT NULL DEFAULT true,
    is_source_deleted   boolean NOT NULL DEFAULT false
);
"""

__all__ = ["PDM_STYLES_DDL"]
