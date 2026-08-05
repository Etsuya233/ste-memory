import { describe, expect, it } from "vitest";
import { datetimeLocalToStored, storedToDatetimeLocal } from "./datetime-format.ts";

describe("storedToDatetimeLocal", () => {
  it("converts the stored space-separated format to datetime-local T format", () => {
    expect(storedToDatetimeLocal("2020-12-12 12:02:11")).toBe("2020-12-12T12:02:11");
  });
});

describe("datetimeLocalToStored", () => {
  it("converts datetime-local values to the stored space-separated format", () => {
    expect(datetimeLocalToStored("2020-12-12T12:02")).toBe("2020-12-12 12:02:00");
    expect(datetimeLocalToStored("2020-12-12T12:02:11")).toBe("2020-12-12 12:02:11");
  });

  it("passes through non datetime-local values untouched", () => {
    expect(datetimeLocalToStored("2020-12-12 12:02:11")).toBe("2020-12-12 12:02:11");
    expect(datetimeLocalToStored("2020-12-12")).toBe("2020-12-12");
  });
});
