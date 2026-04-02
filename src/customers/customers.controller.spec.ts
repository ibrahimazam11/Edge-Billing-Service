import { Test } from "@nestjs/testing";
import { CustomersController } from "./customers.controller";
import { CustomersService } from "./customers.service";
import { CustomerNotFoundException } from "../common/exceptions/customer-not-found.exception";
import type { CustomerResponseDto } from "./dto/customer-response.dto";

const mockCustomerResponse: CustomerResponseDto = {
  id: "01234567-89ab-7def-0123-456789abcdef",
  monolithCustomerId: "mono-123",
  stripeCustomerId: "cus_stripe_123",
  name: "Test Customer",
  email: "test@example.com",
  status: "active",
  metadata: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("CustomersController", () => {
  let controller: CustomersController;
  let service: jest.Mocked<CustomersService>;

  beforeEach(async () => {
    const mockService = {
      findById: jest.fn(),
      findAll: jest.fn(),
      createFromEvent: jest.fn(),
      updateFromEvent: jest.fn(),
      findByMonolithId: jest.fn(),
    };

    const module = await Test.createTestingModule({
      controllers: [CustomersController],
      providers: [{ provide: CustomersService, useValue: mockService }],
    }).compile();

    controller = module.get<CustomersController>(CustomersController);
    service = module.get(CustomersService);
  });

  describe("GET /v1/customers/:id", () => {
    it("should return customer when found", async () => {
      service.findById.mockResolvedValueOnce(mockCustomerResponse);

      const result = await controller.findById(mockCustomerResponse.id);

      expect(result).toEqual(mockCustomerResponse);
      expect(service.findById).toHaveBeenCalledWith(mockCustomerResponse.id);
    });

    it("should throw CustomerNotFoundException when not found", async () => {
      service.findById.mockResolvedValueOnce(null);

      await expect(controller.findById("non-existent")).rejects.toThrow(
        CustomerNotFoundException,
      );
    });
  });

  describe("GET /v1/customers", () => {
    it("should return paginated customers", async () => {
      const paginatedResult = {
        data: [mockCustomerResponse],
        cursor: null,
        hasMore: false,
      };
      service.findAll.mockResolvedValueOnce(paginatedResult);

      const result = await controller.findAll({ limit: 20 });

      expect(result.data).toHaveLength(1);
      expect(result.hasMore).toBe(false);
    });

    it("should pass status filter to service", async () => {
      const paginatedResult = {
        data: [mockCustomerResponse],
        cursor: null,
        hasMore: false,
      };
      service.findAll.mockResolvedValueOnce(paginatedResult);

      await controller.findAll({ status: "active" as never, limit: 20 });

      expect(service.findAll).toHaveBeenCalledWith({
        status: "active",
        limit: 20,
      });
    });

    it("should return empty result when no customers exist", async () => {
      service.findAll.mockResolvedValueOnce({
        data: [],
        cursor: null,
        hasMore: false,
      });

      const result = await controller.findAll({ limit: 20 });

      expect(result.data).toHaveLength(0);
      expect(result.hasMore).toBe(false);
      expect(result.cursor).toBeNull();
    });

    it("should pass cursor for pagination", async () => {
      const paginatedResult = {
        data: [mockCustomerResponse],
        cursor: null,
        hasMore: false,
      };
      service.findAll.mockResolvedValueOnce(paginatedResult);

      await controller.findAll({ cursor: "some-cursor", limit: 20 });

      expect(service.findAll).toHaveBeenCalledWith({
        cursor: "some-cursor",
        limit: 20,
      });
    });

    it("should return hasMore with cursor when more results exist", async () => {
      const paginatedResult = {
        data: [mockCustomerResponse],
        cursor: "next-cursor-id",
        hasMore: true,
      };
      service.findAll.mockResolvedValueOnce(paginatedResult);

      const result = await controller.findAll({ limit: 1 });

      expect(result.hasMore).toBe(true);
      expect(result.cursor).toBe("next-cursor-id");
    });
  });
});
