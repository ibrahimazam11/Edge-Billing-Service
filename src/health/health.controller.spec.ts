import { HealthController } from "./health.controller";
import { HealthCheckService } from "@nestjs/terminus";
import type { DatabaseHealthRepository } from "../database/database-health.repository";

describe("HealthController", () => {
  let controller: HealthController;
  let mockHealthCheckService: { check: jest.Mock };
  let mockDatabaseHealthRepo: { ping: jest.Mock };

  beforeEach(() => {
    mockDatabaseHealthRepo = { ping: jest.fn() };
    mockHealthCheckService = {
      check: jest
        .fn()
        .mockImplementation(async (indicators: (() => Promise<unknown>)[]) => {
          const info: Record<string, unknown> = {};
          for (const indicator of indicators) {
            const result = await indicator();
            Object.assign(info, result as object);
          }
          return { status: "ok", info, error: {}, details: info };
        }),
    };

    controller = new HealthController(
      mockHealthCheckService as unknown as HealthCheckService,
      mockDatabaseHealthRepo as unknown as DatabaseHealthRepository,
    );
  });

  describe("GET /health", () => {
    it("should return healthy when database is accessible", async () => {
      mockDatabaseHealthRepo.ping.mockResolvedValue(true);

      const result = await controller.check();

      expect(result.status).toBe("ok");
      expect(result.info).toEqual(
        expect.objectContaining({ database: { status: "up" } }),
      );
    });

    it("should return down status when database is not accessible", async () => {
      mockDatabaseHealthRepo.ping.mockRejectedValue(
        new Error("Connection refused"),
      );

      const result = await controller.check();

      expect(result.info).toEqual(
        expect.objectContaining({ database: { status: "down" } }),
      );
    });
  });

  describe("GET /ready", () => {
    it("should return ready when database is accessible", async () => {
      mockDatabaseHealthRepo.ping.mockResolvedValue(true);

      const result = await controller.ready();

      expect(result.status).toBe("ok");
      expect(result.info).toEqual(
        expect.objectContaining({ database: { status: "up" } }),
      );
    });

    it("should throw when database is not accessible", async () => {
      mockDatabaseHealthRepo.ping.mockRejectedValue(
        new Error("Connection refused"),
      );

      await expect(controller.ready()).rejects.toThrow("Connection refused");
    });
  });
});
