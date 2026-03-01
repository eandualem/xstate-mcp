/**
 * JSON.stringify wrapper that handles BigInt and circular references.
 * - BigInt values are converted to strings (e.g., 42n → "42")
 * - Circular references are replaced with "[Circular]"
 */
export function safeStringify(value: unknown, indent?: number): string {
  const seen = new WeakSet<object>();

  return JSON.stringify(
    value,
    (_key: string, val: unknown) => {
      if (typeof val === "bigint") {
        return val.toString();
      }
      if (typeof val === "object" && val !== null) {
        if (seen.has(val)) {
          return "[Circular]";
        }
        seen.add(val);
      }
      return val;
    },
    indent,
  );
}
