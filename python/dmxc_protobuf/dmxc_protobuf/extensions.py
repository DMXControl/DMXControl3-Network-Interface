"""Helpers for generated messages (ports of the C# partial class extensions)."""

from __future__ import annotations

import re
from typing import Callable, Iterable, Optional, Sequence, Union

from dmxc_protobuf.Common.Types import CommonTypes_pb2, DependencyTypes_pb2, ValueTypes_pb2
from dmxc_protobuf.Common.Types.Project import ProjectServiceTypes_pb2

SimpleValue = Union[str, int, float, bool]

# ~~~~~~~~~~~~~~~~~~~ ColorData ~~~~~~~~~~~~~~~~~~~


def color_is_white(c: ValueTypes_pb2.ColorData) -> bool:
    return c.a == 255 and c.r == 255 and c.g == 255 and c.b == 255


# ~~~~~~~~~~~~~~~~~~~ Dependencies ~~~~~~~~~~~~~~~~~~~


def dependency_data_not_resolved(d: DependencyTypes_pb2.DependencyData) -> bool:
    """True if this node or any child has unresolved dependencies."""
    return len(d.dependencies) > 0 or any(dependency_data_not_resolved(c) for c in d.children)


def dependency_object_to_tree_string(
    o: DependencyTypes_pb2.DependencyObject, translator: Optional[Callable[[str], str]] = None
) -> str:
    t = translator or (lambda s: s)
    s = t(o.Type) + ": " + o.Name
    if o.HasField("solution"):
        s += " [" + t(o.solution.Solution) + "]"
    return s


def dependency_object_add_possible_solution(
    o: DependencyTypes_pb2.DependencyObject, s: DependencySolution
) -> None:
    """Adds a possible solution and selects it if no solution is selected yet."""
    o.possibleSolutions.append(s)
    if not o.HasField("solution"):
        o.solution.CopyFrom(s)


DependencySolution = DependencyTypes_pb2.DependencySolution

# ~~~~~~~~~~~~~~~~~~~ Project ~~~~~~~~~~~~~~~~~~~

ProjectVersionID = ProjectServiceTypes_pb2.ProjectVersionID

_VERSION_ID_RE = re.compile(r"^([^#]+)(#[0-9]+(\.[0-9]+(\.[0-9]+)?)?)?$")


def project_data_find_version(
    p: ProjectServiceTypes_pb2.ProjectData, id: Optional[ProjectVersionID], compare_guid: bool = True
) -> Optional[ProjectServiceTypes_pb2.ProjectVersionData]:
    if id is None:
        return None
    if compare_guid:
        return next((v for v in p.versions if v.id == id), None)
    vs = project_version_id_to_version_string(id)
    return next((v for v in p.versions if project_version_id_to_version_string(v.id) == vs), None)


def project_version_id_is_no_version(id: ProjectVersionID) -> bool:
    return id.major == 0 and id.minor == 0 and id.revision == 0


def project_version_id_from_string(combined_or_guid: Optional[str], version: Optional[str] = None) -> Optional[ProjectVersionID]:
    """Parses ``guid#major.minor.revision`` (version part optional), or ``guid`` and ``version``
    given separately. Returns None if the string is invalid."""
    combined = f"{combined_or_guid}#{version}" if version is not None else combined_or_guid
    if combined is None or not _VERSION_ID_RE.match(combined):
        return None

    ret = ProjectVersionID(guid=combined)
    if "#" in combined:
        guid, ver = combined.split("#")
        ret.guid = guid
        parts = [int(x) for x in ver.split(".")]
        ret.major = parts[0]
        if len(parts) > 1:
            ret.minor = parts[1]
        if len(parts) > 2:
            ret.revision = parts[2]
    return ret


def project_version_id_to_combined_string(id: ProjectVersionID) -> str:
    v = project_version_id_to_version_string(id)
    return f"{id.guid}#{v}" if v else id.guid


def project_version_id_to_version_string(id: ProjectVersionID) -> str:
    if id.major > 0 or id.minor > 0 or id.revision > 0:
        return f"{id.major}.{id.minor}.{id.revision}"
    return ""


def compare_project_version_ids(a: Optional[ProjectVersionID], b: Optional[ProjectVersionID]) -> int:
    """Orders by guid, then major, minor, revision. Use with ``functools.cmp_to_key``."""
    if a is b:
        return 0
    if a is None:
        return -1
    if b is None:
        return 1
    ka = (a.guid, a.major, a.minor, a.revision)
    kb = (b.guid, b.major, b.minor, b.revision)
    return (ka > kb) - (ka < kb)


def project_version_id_sort_key(id: ProjectVersionID) -> tuple[str, int, int, int]:
    """Sort key matching :func:`compare_project_version_ids`."""
    return (id.guid, id.major, id.minor, id.revision)


def merge_todos(
    existing: Optional[Iterable[ProjectServiceTypes_pb2.ProjectTodoDescriptor]],
    created_or_updated: Optional[Iterable[ProjectServiceTypes_pb2.ProjectTodoDescriptor]],
) -> list[ProjectServiceTypes_pb2.ProjectTodoDescriptor]:
    """Merges todos by id; entries from ``created_or_updated`` replace existing ones."""
    if existing is None:
        return list(created_or_updated or [])
    if created_or_updated is None:
        return list(existing)
    merged = {e.id: e for e in existing}
    for n in created_or_updated:
        merged[n.id] = n
    return list(merged.values())


# ~~~~~~~~~~~~~~~~~~~ Translatable data ~~~~~~~~~~~~~~~~~~~

_SIMPLE_VALUE_FIELDS = {
    "boolValue", "byteValue", "doubleValue", "floatValue", "intValue", "stringValue",
    "longValue", "uintValue", "ulongValue", "shortValue", "sbyteValue", "ushortValue",
}


def object_data_to_object_simple(o: CommonTypes_pb2.ObjectData) -> SimpleValue:
    """Returns the value held by an ObjectData, or "" if it holds none (or an array)."""
    field = o.WhichOneof("value")
    if field not in _SIMPLE_VALUE_FIELDS:
        return ""
    v = getattr(o, field)
    if field == "floatValue":
        # drop the noise from widening float32 to double
        v = float(f"{v:.7g}")
    return v


def _format_value(v: SimpleValue) -> str:
    if isinstance(v, float) and v.is_integer():
        return str(int(v))  # match .NET: 2.0 -> "2"
    return str(v)


_FORMAT_ITEM_RE = re.compile(r"\{\{|\}\}|\{(\d+)(?:,\s*(-?\d+))?(?::[^}]*)?\}")


def format_net_string(fmt: str, args: Sequence[SimpleValue]) -> str:
    """Formats a .NET style composite format string (``{0}``, ``{1,-5}``, ``{{`` / ``}}``).

    Format specifiers (``{0:N2}``) are accepted but ignored; placeholders with a missing
    argument are kept as they are.
    """

    def repl(m: re.Match[str]) -> str:
        if m.group(0) == "{{":
            return "{"
        if m.group(0) == "}}":
            return "}"
        i = int(m.group(1))
        if i >= len(args):
            return m.group(0)
        s = _format_value(args[i])
        if m.group(2) is None:
            return s
        w = int(m.group(2))
        return s.ljust(-w) if w < 0 else s.rjust(w)

    return _FORMAT_ITEM_RE.sub(repl, fmt)


def translateable_to_formatted_string(t: Optional[CommonTypes_pb2.TranslateableData]) -> Optional[str]:
    """Resolves a TranslateableData into its final (untranslated) string."""
    if t is None:
        return None
    if len(t.parameters) == 0:
        return t.formatString

    params: list[SimpleValue] = []
    for p in t.parameters:
        which = p.WhichOneof("value")
        if which == "objectData":
            params.append(object_data_to_object_simple(p.objectData))
        elif which == "translateable":
            params.append(translateable_to_formatted_string(p.translateable) or "")
        else:
            params.append("")
    return format_net_string(t.formatString, params)
