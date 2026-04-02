import { CircuitBreakerService } from "./circuit-breaker.service";

describe("CircuitBreakerService", () => {
  let service: CircuitBreakerService;

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe("closed state (normal operation)", () => {
    beforeEach(() => {
      service = new CircuitBreakerService({
        errorThresholdPercentage: 50,
        resetTimeout: 30000,
        timeout: 10000,
      });
    });

    it("should pass through successful calls", async () => {
      const result = await service.fire(() => Promise.resolve("success"));

      expect(result).toBe("success");
    });

    it("should propagate errors from the action", async () => {
      await expect(
        service.fire(() => Promise.reject(new Error("test error"))),
      ).rejects.toThrow("test error");
    });

    it("should handle multiple successful calls", async () => {
      const results: string[] = [];

      for (let i = 0; i < 5; i++) {
        const result = await service.fire(() => Promise.resolve(`result-${i}`));
        results.push(result);
      }

      expect(results).toEqual([
        "result-0",
        "result-1",
        "result-2",
        "result-3",
        "result-4",
      ]);
    });
  });

  describe("open state (circuit tripped)", () => {
    beforeEach(() => {
      service = new CircuitBreakerService({
        errorThresholdPercentage: 50,
        resetTimeout: 30000,
        timeout: 10000,
      });
    });

    it("should open circuit after error threshold is exceeded", async () => {
      // Fire enough failures to trip the circuit
      for (let i = 0; i < 10; i++) {
        try {
          await service.fire(() => Promise.reject(new Error("fail")));
        } catch {
          // expected
        }
      }

      // Next call should fail fast without executing the action
      let actionExecuted = false;
      await expect(
        service.fire(() => {
          actionExecuted = true;
          return Promise.resolve("should not reach");
        }),
      ).rejects.toThrow();

      expect(actionExecuted).toBe(false);
    });

    it("should fail fast with circuit breaker error when open", async () => {
      // Trip the circuit
      for (let i = 0; i < 10; i++) {
        try {
          await service.fire(() => Promise.reject(new Error("fail")));
        } catch {
          // expected
        }
      }

      await expect(service.fire(() => Promise.resolve("test"))).rejects.toThrow(
        /Breaker is open/,
      );
    });
  });

  describe("half-open state (recovery)", () => {
    beforeEach(() => {
      service = new CircuitBreakerService({
        errorThresholdPercentage: 50,
        resetTimeout: 1000,
        timeout: 10000,
      });
    });

    it("should close circuit on successful test request after reset timeout", async () => {
      // Trip the circuit
      for (let i = 0; i < 10; i++) {
        try {
          await service.fire(() => Promise.reject(new Error("fail")));
        } catch {
          // expected
        }
      }

      // Verify circuit is open
      await expect(service.fire(() => Promise.resolve("test"))).rejects.toThrow(
        /Breaker is open/,
      );

      // Advance past reset timeout to enter half-open
      jest.advanceTimersByTime(1500);

      // Successful request should close the circuit
      const result = await service.fire(() => Promise.resolve("recovered"));
      expect(result).toBe("recovered");

      // Further calls should succeed (circuit is closed again)
      const result2 = await service.fire(() =>
        Promise.resolve("still working"),
      );
      expect(result2).toBe("still working");
    });
  });

  describe("timeout behavior", () => {
    it("should timeout actions exceeding the configured timeout", async () => {
      service = new CircuitBreakerService({
        errorThresholdPercentage: 50,
        resetTimeout: 30000,
        timeout: 100,
      });

      const slowAction = () =>
        new Promise<string>((resolve) => {
          setTimeout(() => resolve("slow"), 5000);
        });

      const promise = service.fire(slowAction);
      jest.advanceTimersByTime(200);

      await expect(promise).rejects.toThrow(/Timed out/);
    });
  });

  describe("state change logging", () => {
    it("should log warning on circuit open", async () => {
      const loggerWarnSpy = jest.fn();
      service = new CircuitBreakerService({
        errorThresholdPercentage: 50,
        resetTimeout: 30000,
        timeout: 10000,
      });

      // Access internal logger and spy on it
      const logger = (service as unknown as { logger: { warn: jest.Mock } })
        .logger;
      logger.warn = loggerWarnSpy;

      // Trip the circuit
      for (let i = 0; i < 10; i++) {
        try {
          await service.fire(() => Promise.reject(new Error("fail")));
        } catch {
          // expected
        }
      }

      expect(loggerWarnSpy).toHaveBeenCalledWith({
        action: "circuit_breaker.state_change",
        circuitState: "open",
      });
    });

    it("should log warning on circuit close after recovery", async () => {
      const loggerWarnSpy = jest.fn();
      service = new CircuitBreakerService({
        errorThresholdPercentage: 50,
        resetTimeout: 1000,
        timeout: 10000,
      });

      const logger = (service as unknown as { logger: { warn: jest.Mock } })
        .logger;
      logger.warn = loggerWarnSpy;

      // Trip the circuit
      for (let i = 0; i < 10; i++) {
        try {
          await service.fire(() => Promise.reject(new Error("fail")));
        } catch {
          // expected
        }
      }

      // Wait for half-open
      jest.advanceTimersByTime(1500);

      // Recover
      await service.fire(() => Promise.resolve("ok"));

      expect(loggerWarnSpy).toHaveBeenCalledWith({
        action: "circuit_breaker.state_change",
        circuitState: "closed",
      });
    });

    it("should log warning on circuit half-open", async () => {
      const loggerWarnSpy = jest.fn();
      service = new CircuitBreakerService({
        errorThresholdPercentage: 50,
        resetTimeout: 1000,
        timeout: 10000,
      });

      const logger = (service as unknown as { logger: { warn: jest.Mock } })
        .logger;
      logger.warn = loggerWarnSpy;

      // Trip the circuit
      for (let i = 0; i < 10; i++) {
        try {
          await service.fire(() => Promise.reject(new Error("fail")));
        } catch {
          // expected
        }
      }

      // Wait for half-open
      jest.advanceTimersByTime(1500);

      expect(loggerWarnSpy).toHaveBeenCalledWith({
        action: "circuit_breaker.state_change",
        circuitState: "half-open",
      });
    });
  });
});
