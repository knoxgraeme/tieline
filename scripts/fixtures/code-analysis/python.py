from __future__ import annotations

import os
import package.tool as tool
from .pkg import thing as alias, other
from .. import parent


@registered
class Café:
    @traced
    async def run(self):
        def nested_in_method():
            return True

        return nested_in_method()

    def same(self):
        return "café"


class Other:
    def same(self):
        return "other"


async def top_level():
    class Nested:
        def execute(self):
            return True

    return Nested()


def _private_helper():
    return False
