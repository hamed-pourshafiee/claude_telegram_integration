/** A JSON object's fields, before their types are checked. */
export type Fields = Readonly<Record<string, unknown>>;

/** `value` as an object's fields, or undefined if it is not a (non-array) object. */
export function asFields(value: unknown): Fields | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Fields)
    : undefined;
}
