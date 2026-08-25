"""码 → 名字的三张对照表。

**上游只给码，不给名字。** 目录库里 style 行上的品牌是裸数字（``"2"``）、品类是裸
主键（``52``）、颜色大类是两字母码（``"BL"``）；翻译成人话要的那几张表没被同步进
来。所以名字在这里，抽自权威源、冻在代码里：

- 品牌：BDE 数仓按款号 join ERP 的 ``brand_name``，再按码聚合（2026-08-25 抽取）。
- 品类：BDE 数仓的 PDM 品类表全量，``id`` 就是 style 行上的那个外键（同日抽取）。
- 色系：目录库自己的字典 ``COLOR_CATEGORY``（同日抽取）。

它们是别人的码表、不是我们的事实，所以放代码里当配置，不进数据库、不进 YAML——性质
同 ``rbac.py`` 的预置角色表。

**上游加了新码，这里查不到就返回 ``None``，绝不猜。** 界面上空一格看得见，猜错了没
人看得见。
"""

from __future__ import annotations

from typing import Final

from iclip.domains.products.models import Brand, Category, ColorGroup

_BRAND_NAMES: Final[dict[str, str]] = {
    "1": "Bruno Marc",
    "2": "DREAM PAIRS",
    # ERP 里两种拼法并存（NORTIV8 1216 款 / NORTIV 8 292 款），取多数那个。
    "3": "NORTIV8",
    "4": "TOETOS",
    "7": "BURUDANI",
    # 童鞋线：ERP 里一半的款登记成父品牌 DREAM PAIRS，这里统一叫童鞋线的名字。
    "8": "DREAM PAIRS KIDS",
    "9": "ALLSWIFIT",
    "10": "SHOEDAZZLE",
    "11": "JUSTFAB",
}

_CATEGORIES: Final[dict[int, tuple[str, str, str]]] = {
    # id: (码, 中文, English)
    34: ("S", "鞋类", "Shoes"),
    35: ("A", "配饰", "Accessories"),
    36: ("P01", "非运动鞋", "Non-Sports"),
    37: ("P02", "运动鞋", "Sports"),
    38: ("P03", "户外鞋", "Outdoor"),
    39: ("P04", "工作&安全鞋", "Work & Safety"),
    40: ("P0101", "单鞋", "Single Shoes"),
    41: ("P0102", "靴子", "Boots"),
    42: ("P0103", "凉鞋", "Sandals"),
    43: ("P0201", "专业运动鞋", "Athletic"),
    44: ("P0202", "休闲运动鞋", "Sneakers"),
    45: ("P0301", "户外鞋", "Outdoor"),
    46: ("P0401", "工作&安全鞋", "Work & Safety"),
    47: ("P0501", "皮带", "Belts"),
    48: ("P0502", "钱包", "Wallets"),
    49: ("P0503", "包", "Bags"),
    50: ("P0504", "袜子", "Socks"),
    51: ("P05", "配饰", "Accessories"),
    52: ("PU", "高跟鞋", "Pumps"),
    53: ("FA", "平底鞋", "Flats"),
    54: ("LS", "乐福鞋", "Loafers"),
    55: ("OX", "牛津鞋", "Oxfords"),
    56: ("SP", "一脚蹬", "Slip-ons"),
    57: ("MU", "穆勒鞋", "Mules"),
    58: ("SL", "拖鞋", "Slippers"),
    59: ("AB", "短靴", "Ankle Boots & Booties"),
    60: ("MB", "中筒靴", "Mid-Calf Boots"),
    61: ("KB", "及膝靴", "Knee-High Boots"),
    62: ("OB", "过膝靴", "Over-the-Knee Boots"),
    63: ("HS", "高跟凉鞋", "Heeled Sandals"),
    64: ("WS", "坡跟凉鞋", "Wedge Sandals"),
    65: ("PS", "厚底凉鞋", "Platform Sandals"),
    66: ("FS", "平底凉鞋", "Flats Sandals"),
    67: ("FF", "夹趾拖", "Flip-Flops"),
    68: ("SS", "凉拖鞋", "Slides Sandals"),
    69: ("ST", "运动凉鞋", "Sport Sandals & Slides"),
    70: ("RS", "跑鞋", "Running Shoes"),
    72: ("SO", "足球鞋", "Soccer Shoes"),
    73: ("BA", "篮球鞋", "Basketball Shoes"),
    74: ("CL", "啦啦队鞋", "Cheerleading Shoes"),
    75: ("SF", "棒&垒球鞋", "Softball & Baseball Shoes"),
    76: ("SK", "滑板鞋", "Skateboarding Shoes"),
    77: ("DA", "舞蹈鞋", "Dance Shoes"),
    78: ("FT", "橄榄球鞋", "Football Shoes"),
    79: ("WA", "健步鞋", "Walking Shoes"),
    80: ("FN", "板鞋", "Fashion Sneakers"),
    81: ("HI", "徒步鞋", "Hiking Shoes"),
    82: ("HB", "徒步靴", "Hiking Boots"),
    83: ("SB", "雪地靴", "Snow Boots"),
    84: ("RB", "雨靴", "Rain Boots"),
    85: ("WT", "水鞋", "Water Shoes"),
    86: ("HC", "医疗用鞋", "Health Care Shoes"),
    87: ("FO", "餐厨用鞋", "Food Service Shoes"),
    88: ("MT", "军事用靴", "Military Boots"),
    89: ("IN", "工业用鞋", "Industrial Shoes"),
    90: ("IB", "工业用靴", "Industrial Boots"),
    91: ("BE", "皮带", "Belts"),
    94: ("WL", "钱包", "Wallets"),
    95: ("BS", "包", "Bags"),
    100: ("SC", "袜子", "Socks"),
    101: ("P0505", "鞋垫", "Insoles"),
    102: ("IS", "鞋垫", "Insoles"),
    104: ("GS", "高尔夫鞋", "Golf Shoes"),
    105: ("TS", "网球鞋", "Tennis Shoes"),
    106: ("C", "服装", "Clothes"),
    107: ("TR", "训练鞋", "Training Shoes"),
    109: ("P0506", "贴纸", "Sticker"),
    111: ("CS", "女性骑行鞋", "Women's Cycling Shoes"),
    112: ("HT", "猎靴", "Hunting boots"),
}

_COLOR_GROUP_NAMES: Final[dict[str, str]] = {
    "BL": "黑色系",
    "WH": "白色系",
    "NU": "裸色系",
    "YE": "黄色系",
    "OR": "橙色系",
    "RE": "红色系",
    "GR": "灰色系",
    "BU": "蓝色系",
    "GE": "绿色系",
    "PU": "紫色系",
    "CC": "组合色",
    "PI": "粉色系",
    "OT": "其他",
    "BR": "棕色系",
    "AL": "杏色系",
}


def brand_for(code: str | None) -> Brand:
    return Brand(code=code, name=_BRAND_NAMES.get(code) if code else None)


def category_for(category_id: int | None) -> Category:
    found = _CATEGORIES.get(category_id) if category_id is not None else None
    if found is None:
        return Category(id=category_id, code=None, name=None, en=None)
    code, name, en = found
    return Category(id=category_id, code=code, name=name, en=en)


def color_group_for(code: str | None) -> ColorGroup | None:
    """颜色大类；上游没打这个标就是没有，不由颜色码去猜。"""

    if not code:
        return None
    return ColorGroup(code=code, name=_COLOR_GROUP_NAMES.get(code))


__all__ = ["brand_for", "category_for", "color_group_for"]
