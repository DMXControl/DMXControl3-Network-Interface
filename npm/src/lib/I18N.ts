import { ObjectData, TranslateableData, TranslateableData_TranslateableObject } from "../Common/Types/CommonTypes";

export type TranslatableParameter = TranslateableData | string | number | bigint | boolean | null | undefined | { toString(): string };

const INT32_MIN = -(2 ** 31);
const INT32_MAX = 2 ** 31 - 1;

function isTranslateableData(p: unknown): p is TranslateableData {
  return typeof p === "object" && p !== null && typeof (p as TranslateableData).formatString === "string" && Array.isArray((p as TranslateableData).parameters);
}

function toObjectData(p: Exclude<TranslatableParameter, TranslateableData>): ObjectData {
  switch (typeof p) {
    case "boolean":
      return ObjectData.fromPartial({ boolValue: p });
    case "bigint":
      return ObjectData.fromPartial({ longValue: Number(p) });
    case "number":
      if (Number.isInteger(p)) {
        return p >= INT32_MIN && p <= INT32_MAX ? ObjectData.fromPartial({ intValue: p }) : ObjectData.fromPartial({ longValue: p });
      }
      return ObjectData.fromPartial({ doubleValue: p });
    default:
      return ObjectData.fromPartial({ stringValue: p == null ? "" : p.toString() });
  }
}

/**
 * Builds a TranslateableData from a .NET style format string (`"{0} of {1}"`) and parameters.
 * Integers in int32 range become `intValue`, larger ones `longValue`, other numbers `doubleValue`,
 * TranslateableData values are nested, and anything else is stored as a string.
 */
export function translatable(formatString: string | null | undefined, ...parameters: TranslatableParameter[]): TranslateableData {
  const r = TranslateableData.fromPartial({ formatString: formatString ?? "" });
  for (const p of parameters) {
    const obj: TranslateableData_TranslateableObject = isTranslateableData(p) ? { translateable: p } : { objectData: toObjectData(p) };
    r.parameters.push(obj);
  }
  return r;
}

/** Short alias for {@link translatable}, like `TranslatableDataBuilder._` in C#. */
export const _ = translatable;
