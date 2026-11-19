"""Builder for TranslateableData (port of the C# ``TranslatableDataBuilder``)."""

from __future__ import annotations

from typing import Any, Optional

from dmxc_protobuf.Common.Types.CommonTypes_pb2 import ObjectData, TranslateableData

_INT32 = (-(2**31), 2**31 - 1)
_INT64 = (-(2**63), 2**63 - 1)
_UINT64_MAX = 2**64 - 1


def _to_object_data(p: Any) -> ObjectData:
    if isinstance(p, bool):  # before int: bool is a subclass of int
        return ObjectData(boolValue=p)
    if isinstance(p, int):
        if _INT32[0] <= p <= _INT32[1]:
            return ObjectData(intValue=p)
        if _INT64[0] <= p <= _INT64[1]:
            return ObjectData(longValue=p)
        if 0 <= p <= _UINT64_MAX:
            return ObjectData(ulongValue=p)
        return ObjectData(stringValue=str(p))
    if isinstance(p, float):
        return ObjectData(doubleValue=p)
    return ObjectData(stringValue="" if p is None else str(p))


def translatable(format_string: Optional[str], *parameters: Any) -> TranslateableData:
    """Builds a TranslateableData from a .NET style format string (``"{0} of {1}"``).

    Integers in int32 range become ``intValue``, larger ones ``longValue`` (or ``ulongValue``),
    floats ``doubleValue``, TranslateableData values are nested, and anything else is stored
    as a string.
    """
    r = TranslateableData(formatString=format_string or "")
    for p in parameters:
        if isinstance(p, TranslateableData):
            r.parameters.add(translateable=p)
        else:
            r.parameters.add(objectData=_to_object_data(p))
    return r


#: Short alias, like ``TranslatableDataBuilder._`` in C#.
_ = translatable
