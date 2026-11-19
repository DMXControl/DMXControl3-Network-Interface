const { test } = require("node:test");
const assert = require("node:assert/strict");
const lib = require("../dist");

const { LumosProtobuf: T } = lib;

test("containsNonAsciiCharacters", () => {
  assert.equal(lib.containsNonAsciiCharacters("abc"), false);
  assert.equal(lib.containsNonAsciiCharacters("äbc"), true);
  assert.equal(lib.containsNonAsciiCharacters("a\tb"), false);
  assert.equal(lib.containsNonAsciiCharacters("a\tb", true), true);
});

test("color and dependencies", () => {
  assert.equal(lib.colorIsWhite({ r: 255, g: 255, b: 255, a: 255 }), true);
  assert.equal(lib.colorIsWhite({ r: 255, g: 255, b: 255, a: 0 }), false);

  const d = T.DependencyData.fromPartial({ children: [{}] });
  assert.equal(lib.dependencyDataNotResolved(d), false);
  d.children[0].dependencies.push(T.DependencyObject.fromPartial({ Name: "x" }));
  assert.equal(lib.dependencyDataNotResolved(d), true);

  const o = T.DependencyObject.fromPartial({ Type: "Device", Name: "Spot" });
  assert.equal(lib.dependencyObjectToTreeString(o), "Device: Spot");
  lib.dependencyObjectAddPossibleSolution(o, T.DependencySolution.fromPartial({ Solution: "Remove" }));
  lib.dependencyObjectAddPossibleSolution(o, T.DependencySolution.fromPartial({ Solution: "Other" }));
  assert.equal(o.possibleSolutions.length, 2);
  assert.equal(lib.dependencyObjectToTreeString(o, (s) => s.toUpperCase()), "DEVICE: Spot [REMOVE]");
});

test("project version ids", () => {
  assert.equal(lib.projectVersionIdFromString("abc#1.x"), undefined);
  assert.equal(lib.projectVersionIdFromString(null), undefined);
  const v = lib.projectVersionIdFromString("abc#1.2.3");
  assert.deepEqual(v, { guid: "abc", major: 1, minor: 2, revision: 3 });
  const v2 = lib.projectVersionIdFromString("abc", "4");
  const plain = lib.projectVersionIdFromString("abc");
  assert.equal(lib.projectVersionIdIsNoVersion(plain), true);
  assert.equal(lib.projectVersionIdToCombinedString(plain), "abc");
  assert.equal(lib.projectVersionIdToCombinedString(v), "abc#1.2.3");
  assert.deepEqual([v2, plain, v].sort(lib.compareProjectVersionIds).map(lib.projectVersionIdToCombinedString), ["abc", "abc#1.2.3", "abc#4.0.0"]);

  const p = T.ProjectData.fromPartial({ versions: [{ id: { guid: "g", major: 1 } }] });
  assert.ok(lib.projectDataFindVersion(p, { guid: "g", major: 1, minor: 0, revision: 0 }));
  assert.equal(lib.projectDataFindVersion(p, { guid: "h", major: 1, minor: 0, revision: 0 }), undefined);
  assert.ok(lib.projectDataFindVersion(p, { guid: "h", major: 1, minor: 0, revision: 0 }, false));
});

test("mergeToDos", () => {
  const td = (id, name) => T.ProjectTodoDescriptor.fromPartial({ id, name });
  assert.deepEqual(lib.mergeToDos([td("1", "a"), td("2", "b")], [td("1", "a2")]).map((t) => t.name), ["a2", "b"]);
  assert.deepEqual(lib.mergeToDos(null, null), []);
});

test("object data and formatting", () => {
  assert.equal(lib.objectDataToObjectSimple(T.ObjectData.fromPartial({})), "");
  const f = T.ObjectData.decode(T.ObjectData.encode(T.ObjectData.fromPartial({ floatValue: 0.1 })).finish());
  assert.equal(lib.objectDataToObjectSimple(f), 0.1);
  assert.equal(lib.formatNetString("{0}-{1,4}|{1,-4}|{{x}} {2}", ["a", 7]), "a-   7|7   |{x} {2}");
});

test("translatable round trip", () => {
  const inner = lib.translatable("{0}!", "hi");
  const t = lib._("{0} {1} {2} {3} {4} {5}", true, 3, 2 ** 40, 1.5, inner, null);
  const kinds = t.parameters.map((p) => (p.translateable ? "translateable" : Object.keys(p.objectData).find((k) => p.objectData[k] !== undefined && !k.endsWith("AQ"))));
  assert.deepEqual(kinds, ["boolValue", "intValue", "longValue", "doubleValue", "translateable", "stringValue"]);
  assert.equal(lib.translateableToFormattedString(t), `True 3 ${2 ** 40} 1.5 hi! `);
  assert.equal(lib.translateableToFormattedString(lib.translatable("{{0}}")), "{{0}}");
  assert.equal(lib.translatable(null).formatString, "");
});
