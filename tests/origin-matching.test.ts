import { describe, it, expect } from "vitest";
import { matchesAllowedOrigin } from "../src/ws-server.js";

describe("matchesAllowedOrigin", () => {
  const defaultPatterns = ["http://localhost:*", "http://127.0.0.1:*"];

  it("matches localhost with wildcard port", () => {
    expect(matchesAllowedOrigin("http://localhost:3000", defaultPatterns)).toBe(
      true,
    );
    expect(matchesAllowedOrigin("http://localhost:7357", defaultPatterns)).toBe(
      true,
    );
    expect(
      matchesAllowedOrigin("http://localhost:65535", defaultPatterns),
    ).toBe(true);
  });

  it("matches localhost without port (wildcard port is optional)", () => {
    expect(matchesAllowedOrigin("http://localhost", defaultPatterns)).toBe(
      true,
    );
  });

  it("matches 127.0.0.1 with wildcard port", () => {
    expect(matchesAllowedOrigin("http://127.0.0.1:3000", defaultPatterns)).toBe(
      true,
    );
    expect(matchesAllowedOrigin("http://127.0.0.1:8080", defaultPatterns)).toBe(
      true,
    );
  });

  it("matches 127.0.0.1 without port", () => {
    expect(matchesAllowedOrigin("http://127.0.0.1", defaultPatterns)).toBe(
      true,
    );
  });

  it("rejects non-matching origins", () => {
    expect(
      matchesAllowedOrigin("http://evil.example.com", defaultPatterns),
    ).toBe(false);
    expect(
      matchesAllowedOrigin("https://localhost:3000", defaultPatterns),
    ).toBe(false);
    expect(
      matchesAllowedOrigin("http://192.168.1.1:3000", defaultPatterns),
    ).toBe(false);
  });

  it("matches exact patterns (no wildcard)", () => {
    const exactPatterns = ["https://dashboard.example.com:443"];
    expect(
      matchesAllowedOrigin("https://dashboard.example.com:443", exactPatterns),
    ).toBe(true);
    expect(
      matchesAllowedOrigin("https://dashboard.example.com:8080", exactPatterns),
    ).toBe(false);
  });

  it("returns false for empty patterns", () => {
    expect(matchesAllowedOrigin("http://localhost:3000", [])).toBe(false);
  });
});
