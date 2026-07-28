import { DomainError, memorySpaceName } from "../src/index.ts";
import { describe, expect, it } from "vitest";

describe("domain errors", () => {
  it("describes a required memory space name with a stable type", () => {
    expect(() => memorySpaceName("  ")).toThrowError(
      expect.objectContaining({
        type: "memory_space_name_required",
        humanMsg: "记忆空间名称不能为空",
      }),
    );
  });

  it("provides translation parameters for a name that is too long", () => {
    try {
      memorySpaceName("a".repeat(121));
      expect.unreachable("memorySpaceName should reject names longer than 120 characters");
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      expect(error).toMatchObject({
        type: "memory_space_name_too_long",
        param: { maxLength: 120 },
        humanMsg: "记忆空间名称不能超过 120 个字符",
      });
    }
  });
});
