import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { bearerToken, isWithin, resolveWithin, sameOrigin } from "./index.ts";

describe("sameOrigin", () => {
  it("accepts only matching origin hosts", () => {
    expect(sameOrigin("http://127.0.0.1:3080", "127.0.0.1:3080")).toBe(true);
    expect(sameOrigin("https://evil.example", "127.0.0.1:3080")).toBe(false);
    expect(sameOrigin(undefined, "127.0.0.1:3080")).toBe(false);
  });
});

describe("bearerToken", () => {
  it("extracts a non-empty bearer token", () => {
    expect(bearerToken({ get: () => "Bearer abc" })).toBe("abc");
    expect(bearerToken({ get: () => "Bearer   " })).toBeUndefined();
    expect(bearerToken({ get: () => "Basic abc" })).toBeUndefined();
    expect(bearerToken({ get: () => null })).toBeUndefined();
  });
});

describe("path safety", () => {
  it("normalizes paths before checking containment", () => {
    expect(isWithin("/tmp/root", "/tmp/root/../../etc/passwd")).toBe(false);
    expect(() => resolveWithin("/tmp/root", "../escape.txt")).toThrow(
      /escapes root/,
    );
    expect(resolveWithin("/tmp/root", "./nested/../file.txt")).toBe(
      resolve("/tmp/root/file.txt"),
    );
    expect(() => resolveWithin("/tmp/root", "bad\0path")).toThrow(/null byte/);
  });
});
