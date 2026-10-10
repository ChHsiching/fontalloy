"""The WebApp builder's recipe output parses through the strict loader.

The static WebApp (issue #21) generates recipe YAML in the browser. The
contract is pinned from both ends: this test proves the checked-in sample
(what the builder emits, byte-for-byte semantics) parses through
:func:`fontalloy_core.load_recipe` into exactly the expected structure;
the seam-3 web suite proves the builder produces the same YAML for the
corresponding builder state (``web/tests/fixtures/sample-recipe.yaml``).
"""

from pathlib import Path

from fontalloy_core import load_recipe
from fontalloy_core.precedence import CODEPOINT, RANGE, SET

FIXTURE = (
    Path(__file__).parent.parent / "web" / "tests" / "fixtures" / "sample-recipe.yaml"
)


def test_webapp_sample_recipe_parses() -> None:
    recipe = load_recipe(FIXTURE)

    assert recipe.base.path.name == "MapleMonoNerdFont-CN-Regular.ttf"
    assert recipe.base.face is None
    assert recipe.base.instance is None

    assert [d.path.name for d in recipe.donors] == [
        "LXGWWenKai-Regular.ttf",
        "SourceHanSansSC-Regular.ttc",
    ]
    assert recipe.donors[1].face == 1

    assert [(r.granularity, r.fonts) for r in recipe.rules] == [
        (SET, ("donor-0",)),
        (RANGE, ("base", "donor-1")),
        (CODEPOINT, ("donor-1",)),
    ]
    assert recipe.rules[0].set_name == "ja"
    assert recipe.rules[1].span == (0x2100, 0x214F)
    assert recipe.rules[2].codepoint == 0x4E2D

    assert recipe.output.family == "My-Merged-Font"
    assert recipe.output.format == "ttf"
