export type MemorySpaceId = string & { readonly __brand: "MemorySpaceId" };

export interface MemorySpace {
  readonly id: MemorySpaceId;
  readonly name: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function memorySpaceName(value: string): string {
  const name = value.trim();
  if (name.length === 0) {
    throw new Error("Memory space name is required");
  }
  if (name.length > 120) {
    throw new Error("Memory space name must not exceed 120 characters");
  }
  return name;
}
