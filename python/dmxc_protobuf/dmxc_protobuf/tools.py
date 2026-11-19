import re

_NON_ASCII = re.compile(r"[^\x00-\x7F]")
_NON_PRINTABLE_ASCII = re.compile(r"[^\x20-\x7E]")


def contains_non_ascii_characters(value: str, also_check_non_printable: bool = False) -> bool:
    """True if ``value`` contains non-ASCII characters (or, with ``also_check_non_printable``,
    anything outside 0x20-0x7E)."""
    pattern = _NON_PRINTABLE_ASCII if also_check_non_printable else _NON_ASCII
    return pattern.search(value) is not None
