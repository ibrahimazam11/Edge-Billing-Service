import { generateId } from "./uuid.util";

describe("UUID Utility", () => {
  it("should generate a valid UUIDv7 string", () => {
    const id = generateId();
    // UUIDv7 format: xxxxxxxx-xxxx-7xxx-xxxx-xxxxxxxxxxxx
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("should generate unique IDs", () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateId()));
    expect(ids.size).toBe(100);
  });

  it("should generate time-ordered IDs", () => {
    const id1 = generateId();
    const id2 = generateId();
    // UUIDv7 IDs generated in sequence should be lexicographically ordered
    expect(id1 < id2 || id1 === id2).toBe(true);
  });
});
