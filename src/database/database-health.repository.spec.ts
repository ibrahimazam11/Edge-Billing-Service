import { DatabaseHealthRepository } from "./database-health.repository";
import type { DrizzleDatabase } from "./types";

describe("DatabaseHealthRepository", () => {
  let repo: DatabaseHealthRepository;
  let mockDb: { execute: jest.Mock };

  beforeEach(() => {
    mockDb = { execute: jest.fn() };
    repo = new DatabaseHealthRepository(mockDb as unknown as DrizzleDatabase);
  });

  it("should return true when database responds", async () => {
    mockDb.execute.mockResolvedValue([]);
    const result = await repo.ping();
    expect(result).toBe(true);
    expect(mockDb.execute).toHaveBeenCalledTimes(1);
  });

  it("should propagate errors when database is unreachable", async () => {
    mockDb.execute.mockRejectedValue(new Error("Connection refused"));
    await expect(repo.ping()).rejects.toThrow("Connection refused");
  });
});
