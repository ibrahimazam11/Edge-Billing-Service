import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { App } from "supertest/types";
import { createTestApp } from "./helpers/test-app";
import {
  setupTestDatabase,
  cleanDatabase,
  closeDatabase,
} from "./helpers/database";

describe("Health Endpoints (e2e)", () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    await setupTestDatabase();
    app = await createTestApp();
  });

  afterAll(async () => {
    await cleanDatabase();
    await app.close();
    await closeDatabase();
  });

  describe("GET /health", () => {
    it("should return health status with database up", async () => {
      const response = await request(app.getHttpServer())
        .get("/health")
        .expect(200);

      expect(response.body).toMatchObject({
        status: "ok",
        info: {
          database: { status: "up" },
        },
      });
    });

    it("should not require authentication (public endpoint)", async () => {
      // No HMAC headers — should still succeed
      await request(app.getHttpServer()).get("/health").expect(200);
    });
  });

  describe("GET /ready", () => {
    it("should return readiness status with database up", async () => {
      const response = await request(app.getHttpServer())
        .get("/ready")
        .expect(200);

      expect(response.body).toMatchObject({
        status: "ok",
        info: {
          database: { status: "up" },
        },
      });
    });

    it("should not require authentication (public endpoint)", async () => {
      await request(app.getHttpServer()).get("/ready").expect(200);
    });
  });
});
