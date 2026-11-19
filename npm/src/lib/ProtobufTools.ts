/**
 * Returns true if `value` contains characters outside of ASCII. With
 * `alsoCheckNonPrintable`, control characters (outside 0x20-0x7E) count as well.
 */
export function containsNonAsciiCharacters(value: string, alsoCheckNonPrintable = false): boolean {
  return alsoCheckNonPrintable ? /[^ -~]/.test(value) : /[^\u0000-\u007F]/.test(value);
}
