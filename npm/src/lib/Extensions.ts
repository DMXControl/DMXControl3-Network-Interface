import { ObjectData, TranslateableData } from "../Common/Types/CommonTypes";
import { DependencyData, DependencyObject, DependencySolution } from "../Common/Types/DependencyTypes";
import { ProjectData, ProjectTodoDescriptor, ProjectVersionData, ProjectVersionID } from "../Common/Types/Project/ProjectServiceTypes";
import { ColorData } from "../Common/Types/ValueTypes";

export type SimpleValue = string | number | boolean;

// ~~~~~~~~~~~~~~~~~~~ ColorData ~~~~~~~~~~~~~~~~~~~

export function colorIsWhite(c: ColorData): boolean {
  return c.a === 255 && c.r === 255 && c.g === 255 && c.b === 255;
}

// ~~~~~~~~~~~~~~~~~~~ Dependencies ~~~~~~~~~~~~~~~~~~~

/** True if this node or any child has unresolved dependencies. */
export function dependencyDataNotResolved(d: DependencyData): boolean {
  return d.dependencies.length > 0 || d.children.some(dependencyDataNotResolved);
}

export function dependencyObjectToTreeString(o: DependencyObject, translator?: (s: string) => string): string {
  const t = translator ?? ((s: string) => s);
  let s = t(o.Type) + ": " + o.Name;
  if (o.solution) s += " [" + t(o.solution.Solution) + "]";
  return s;
}

/** Adds a possible solution and selects it if no solution is selected yet. */
export function dependencyObjectAddPossibleSolution(o: DependencyObject, s: DependencySolution): void {
  o.possibleSolutions.push(s);
  if (!o.solution) o.solution = s;
}

// ~~~~~~~~~~~~~~~~~~~ Project ~~~~~~~~~~~~~~~~~~~

function versionIdEquals(a: ProjectVersionID | undefined, b: ProjectVersionID | undefined): boolean {
  if (!a || !b) return a === b;
  return a.guid === b.guid && a.major === b.major && a.minor === b.minor && a.revision === b.revision;
}

export function projectDataFindVersion(p: ProjectData, id: ProjectVersionID | undefined | null, compareGuid = true): ProjectVersionData | undefined {
  if (!id) return undefined;
  if (compareGuid) return p.versions.find((c) => versionIdEquals(c.id, id));

  const vs = projectVersionIdToVersionString(id);
  return p.versions.find((c) => c.id !== undefined && projectVersionIdToVersionString(c.id) === vs);
}

export function projectVersionIdIsNoVersion(id: ProjectVersionID): boolean {
  return id.major === 0 && id.minor === 0 && id.revision === 0;
}

/**
 * Parses `guid#major.minor.revision` (version part optional), or `guid` and `version` given separately.
 * Returns undefined if the string is invalid.
 */
export function projectVersionIdFromString(combinedOrGuid: string | null | undefined, version?: string): ProjectVersionID | undefined {
  const combined = version !== undefined ? combinedOrGuid + "#" + version : combinedOrGuid;
  if (combined == null || !/^([^#]+)(#[0-9]+(\.[0-9]+(\.[0-9]+)?)?)?$/.test(combined)) return undefined;

  const ret: ProjectVersionID = { guid: combined, major: 0, minor: 0, revision: 0 };
  if (combined.includes("#")) {
    const v = combined.split("#");
    ret.guid = v[0];
    const tmp = v[1].split(".");
    if (tmp.length > 2) ret.revision = parseInt(tmp[2], 10);
    if (tmp.length > 1) ret.minor = parseInt(tmp[1], 10);
    ret.major = parseInt(tmp[0], 10);
  }
  return ret;
}

export function projectVersionIdToCombinedString(id: ProjectVersionID): string {
  const v = projectVersionIdToVersionString(id);
  return v ? id.guid + "#" + v : id.guid;
}

export function projectVersionIdToVersionString(id: ProjectVersionID): string {
  if (id.major > 0 || id.minor > 0 || id.revision > 0) return `${id.major}.${id.minor}.${id.revision}`;
  return "";
}

function cmp<T extends string | number>(a: T, b: T): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Orders by guid (ordinal), then major, minor, revision. Usable with `Array.prototype.sort`. */
export function compareProjectVersionIds(a: ProjectVersionID | null | undefined, b: ProjectVersionID | null | undefined): number {
  if (a === b) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  return cmp(a.guid, b.guid) || cmp(a.major, b.major) || cmp(a.minor, b.minor) || cmp(a.revision, b.revision);
}

/** Merges todos by id; entries from `createdOrUpdated` replace existing ones. */
export function mergeToDos(
  existing: Iterable<ProjectTodoDescriptor> | null | undefined,
  createdOrUpdated: Iterable<ProjectTodoDescriptor> | null | undefined,
): ProjectTodoDescriptor[] {
  if (existing == null) return createdOrUpdated ? [...createdOrUpdated] : [];
  if (createdOrUpdated == null) return [...existing];

  const map = new Map<string, ProjectTodoDescriptor>();
  for (const e of existing) map.set(e.id, e);
  for (const n of createdOrUpdated) map.set(n.id, n);
  return [...map.values()];
}

// ~~~~~~~~~~~~~~~~~~~ Translatable data ~~~~~~~~~~~~~~~~~~~

/** Returns the value held by an ObjectData, or "" if it holds none (or an array). */
export function objectDataToObjectSimple(o: ObjectData): SimpleValue {
  // drop the noise from widening float32 to double
  if (o.floatValue !== undefined) return Number(o.floatValue.toPrecision(7));
  const values = [
    o.boolValue, o.byteValue, o.doubleValue, o.floatValue, o.intValue, o.stringValue,
    o.longValue, o.uintValue, o.ulongValue, o.shortValue, o.sbyteValue, o.ushortValue,
  ];
  for (const v of values) if (v !== undefined) return v;
  return "";
}

function formatValue(v: SimpleValue): string {
  // match .NET's formatting of booleans
  if (typeof v === "boolean") return v ? "True" : "False";
  return String(v);
}

/**
 * Formats a .NET style composite format string (`{0}`, `{1,-5}`, `{{` / `}}` escapes).
 * Format specifiers (`{0:N2}`) are accepted but ignored; placeholders with a missing
 * argument are kept as they are.
 */
export function formatNetString(format: string, args: readonly SimpleValue[]): string {
  return format.replace(/\{\{|\}\}|\{(\d+)(?:,\s*(-?\d+))?(?::[^}]*)?\}/g, (m, idx?: string, align?: string) => {
    if (m === "{{") return "{";
    if (m === "}}") return "}";
    const i = Number(idx);
    if (i >= args.length) return m;
    const s = formatValue(args[i]);
    if (!align) return s;
    const w = Number(align);
    return w < 0 ? s.padEnd(-w) : s.padStart(w);
  });
}

/** Resolves a TranslateableData into its final (untranslated) string. */
export function translateableToFormattedString(t: TranslateableData | null | undefined): string | undefined {
  if (t == null) return undefined;
  if (t.parameters.length === 0) return t.formatString;

  const params = t.parameters.map((p): SimpleValue => {
    if (p.objectData) return objectDataToObjectSimple(p.objectData);
    if (p.translateable) return translateableToFormattedString(p.translateable) ?? "";
    return "";
  });
  return formatNetString(t.formatString, params);
}
