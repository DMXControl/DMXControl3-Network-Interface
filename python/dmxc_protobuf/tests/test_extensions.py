import functools
import unittest

from dmxc_protobuf.Common.Types.CommonTypes_pb2 import ObjectData
from dmxc_protobuf.Common.Types.DependencyTypes_pb2 import DependencyData, DependencyObject, DependencySolution
from dmxc_protobuf.Common.Types.Project.ProjectServiceTypes_pb2 import (
    ProjectData,
    ProjectTodoDescriptor,
    ProjectVersionData,
    ProjectVersionID,
)
from dmxc_protobuf.Common.Types.ValueTypes_pb2 import ColorData
from dmxc_protobuf.extensions import (
    color_is_white,
    compare_project_version_ids,
    dependency_data_not_resolved,
    dependency_object_add_possible_solution,
    dependency_object_to_tree_string,
    format_net_string,
    merge_todos,
    object_data_to_object_simple,
    project_data_find_version,
    project_version_id_from_string,
    project_version_id_is_no_version,
    project_version_id_to_combined_string,
    translateable_to_formatted_string,
)
from dmxc_protobuf.i18n import _, translatable
from dmxc_protobuf.tools import contains_non_ascii_characters


class ToolsTest(unittest.TestCase):
    def test_non_ascii(self):
        self.assertFalse(contains_non_ascii_characters("abc"))
        self.assertTrue(contains_non_ascii_characters("äbc"))
        self.assertFalse(contains_non_ascii_characters("a\tb"))
        self.assertTrue(contains_non_ascii_characters("a\tb", True))


class ExtensionsTest(unittest.TestCase):
    def test_color(self):
        self.assertTrue(color_is_white(ColorData(r=255, g=255, b=255, a=255)))
        self.assertFalse(color_is_white(ColorData(r=255, g=255, b=255, a=0)))

    def test_dependencies(self):
        d = DependencyData(children=[DependencyData()])
        self.assertFalse(dependency_data_not_resolved(d))
        d.children[0].dependencies.add(Name="x")
        self.assertTrue(dependency_data_not_resolved(d))

        o = DependencyObject(Type="Device", Name="Spot")
        self.assertEqual(dependency_object_to_tree_string(o), "Device: Spot")
        dependency_object_add_possible_solution(o, DependencySolution(Solution="Remove"))
        dependency_object_add_possible_solution(o, DependencySolution(Solution="Other"))
        self.assertEqual(len(o.possibleSolutions), 2)
        self.assertEqual(dependency_object_to_tree_string(o, str.upper), "DEVICE: Spot [REMOVE]")

    def test_project_version_id(self):
        self.assertIsNone(project_version_id_from_string("abc#1.x"))
        self.assertIsNone(project_version_id_from_string(None))
        v = project_version_id_from_string("abc#1.2.3")
        self.assertEqual((v.guid, v.major, v.minor, v.revision), ("abc", 1, 2, 3))
        v2 = project_version_id_from_string("abc", "4")
        self.assertEqual((v2.guid, v2.major, v2.minor), ("abc", 4, 0))
        plain = project_version_id_from_string("abc")
        self.assertTrue(project_version_id_is_no_version(plain))
        self.assertEqual(project_version_id_to_combined_string(plain), "abc")
        self.assertEqual(project_version_id_to_combined_string(v), "abc#1.2.3")

        ids = [v2, plain, v]
        ids.sort(key=functools.cmp_to_key(compare_project_version_ids))
        self.assertEqual([project_version_id_to_combined_string(i) for i in ids], ["abc", "abc#1.2.3", "abc#4.0.0"])

    def test_find_version(self):
        p = ProjectData(versions=[ProjectVersionData(id=ProjectVersionID(guid="g", major=1))])
        self.assertIsNotNone(project_data_find_version(p, ProjectVersionID(guid="g", major=1)))
        self.assertIsNone(project_data_find_version(p, ProjectVersionID(guid="h", major=1)))
        self.assertIsNotNone(project_data_find_version(p, ProjectVersionID(guid="h", major=1), compare_guid=False))

    def test_merge_todos(self):
        a = ProjectTodoDescriptor(id="1", name="a")
        b = ProjectTodoDescriptor(id="2", name="b")
        a2 = ProjectTodoDescriptor(id="1", name="a2")
        self.assertEqual([t.name for t in merge_todos([a, b], [a2])], ["a2", "b"])
        self.assertEqual(merge_todos(None, None), [])

    def test_object_data(self):
        self.assertEqual(object_data_to_object_simple(ObjectData()), "")
        self.assertEqual(object_data_to_object_simple(ObjectData(floatValue=0.1)), 0.1)
        self.assertIs(object_data_to_object_simple(ObjectData(boolValue=True)), True)

    def test_format(self):
        self.assertEqual(format_net_string("{0}-{1,4}|{1,-4}|{{x}} {2}", ["a", 7]), "a-   7|7   |{x} {2}")


class TranslatableTest(unittest.TestCase):
    def test_roundtrip(self):
        inner = translatable("{0}!", "hi")
        t = _("{0} {1} {2} {3} {4} {5}", True, 3, 2**40, 1.5, inner, None)
        kinds = [p.objectData.WhichOneof("value") if p.HasField("objectData") else "translateable" for p in t.parameters]
        self.assertEqual(kinds, ["boolValue", "intValue", "longValue", "doubleValue", "translateable", "stringValue"])
        self.assertEqual(translateable_to_formatted_string(t), f"True 3 {2**40} 1.5 hi! ")

    def test_no_params(self):
        self.assertEqual(translateable_to_formatted_string(translatable("{{0}}")), "{{0}}")
        self.assertEqual(translatable(None).formatString, "")


if __name__ == "__main__":
    unittest.main()
