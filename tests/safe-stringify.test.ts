import { describe, it, expect } from "vitest";
import { safeStringify } from "../src/safe-stringify.js";

describe("safeStringify", () => {
  it("serializes plain objects like JSON.stringify", () => {
    const obj = { a: 1, b: "hello", c: [1, 2, 3] };
    expect(safeStringify(obj)).toBe(JSON.stringify(obj));
  });

  it("supports indent parameter", () => {
    const obj = { a: 1 };
    expect(safeStringify(obj, 2)).toBe(JSON.stringify(obj, null, 2));
  });

  it("converts BigInt values to strings", () => {
    const obj = { count: BigInt(42), name: "test" };
    const result = JSON.parse(safeStringify(obj));
    expect(result.count).toBe("42");
    expect(result.name).toBe("test");
  });

  it("converts nested BigInt values", () => {
    const obj = { data: { big: BigInt("9007199254740993") } };
    const result = JSON.parse(safeStringify(obj));
    expect(result.data.big).toBe("9007199254740993");
  });

  it("handles circular references", () => {
    const obj: Record<string, unknown> = { a: 1 };
    obj.self = obj;
    const result = JSON.parse(safeStringify(obj));
    expect(result.a).toBe(1);
    expect(result.self).toBe("[Circular]");
  });

  it("handles deeply nested circular references", () => {
    const obj: Record<string, unknown> = { a: { b: { c: {} } } };
    (obj.a as Record<string, unknown>).b = (obj.a as Record<string, unknown>).b;
    ((obj.a as Record<string, unknown>).b as Record<string, unknown>).back =
      obj;
    const result = JSON.parse(safeStringify(obj));
    expect(result.a.b.back).toBe("[Circular]");
  });

  it("handles null and undefined", () => {
    expect(safeStringify(null)).toBe("null");
    expect(safeStringify(undefined)).toBeUndefined();
    expect(safeStringify({ a: null, b: undefined })).toBe('{"a":null}');
  });

  it("handles arrays with BigInt", () => {
    const arr = [BigInt(1), BigInt(2), BigInt(3)];
    const result = JSON.parse(safeStringify(arr));
    expect(result).toEqual(["1", "2", "3"]);
  });

  it("handles both BigInt and circular references together", () => {
    const obj: Record<string, unknown> = { count: BigInt(100) };
    obj.self = obj;
    const result = JSON.parse(safeStringify(obj));
    expect(result.count).toBe("100");
    expect(result.self).toBe("[Circular]");
  });
});
