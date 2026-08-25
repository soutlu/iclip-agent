"""码 → 名字三张对照表的口径：认得的翻译成人话，不认得的空着。

这几条守的是同一件事：**上游加了新码时不许猜**。猜错的名字会一路流到界面上，而
且没人看得出来它是错的。
"""

from __future__ import annotations

from iclip.domains.products.tables import brand_for, category_for, color_group_for


def test_known_codes_are_translated() -> None:
    assert brand_for("1").name == "Bruno Marc"
    assert brand_for("8").name == "DREAM PAIRS KIDS"

    category = category_for(52)
    assert (category.code, category.name, category.en) == ("PU", "高跟鞋", "Pumps")

    group = color_group_for("BL")
    assert group is not None
    assert group.name == "黑色系"


def test_unknown_codes_keep_the_code_and_drop_the_name() -> None:
    """码是上游的事实，永远带出去；名字是我们的对照表，查不到就是没有。"""

    unknown_brand = brand_for("999")
    assert (unknown_brand.code, unknown_brand.name) == ("999", None)

    unknown_category = category_for(99999)
    assert (unknown_category.id, unknown_category.code, unknown_category.name) == (
        99999,
        None,
        None,
    )

    unknown_group = color_group_for("ZZ")
    assert unknown_group is not None
    assert (unknown_group.code, unknown_group.name) == ("ZZ", None)


def test_missing_codes_are_not_guessed() -> None:
    """上游这一格是空的：不由别的字段推一个出来。"""

    assert brand_for(None).code is None
    assert category_for(None).id is None
    assert color_group_for(None) is None
    assert color_group_for("") is None
