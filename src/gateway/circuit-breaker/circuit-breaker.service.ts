import { Injectable, Logger, Optional, Inject } from "@nestjs/common";
import CircuitBreaker from "opossum";

export const CIRCUIT_BREAKER_OPTIONS = Symbol("CIRCUIT_BREAKER_OPTIONS");

export interface CircuitBreakerOptions {
  errorThresholdPercentage?: number;
  resetTimeout?: number;
  timeout?: number;
}

const DEFAULT_OPTIONS: Required<CircuitBreakerOptions> = {
  errorThresholdPercentage: 50,
  resetTimeout: 30000,
  timeout: 10000,
};

@Injectable()
export class CircuitBreakerService {
  private readonly logger = new Logger(CircuitBreakerService.name);
  private readonly breaker: CircuitBreaker;

  constructor(
    @Optional()
    @Inject(CIRCUIT_BREAKER_OPTIONS)
    options?: CircuitBreakerOptions,
  ) {
    const mergedOptions = { ...DEFAULT_OPTIONS, ...options };

    // opossum requires a function to wrap; we use a passthrough
    // that executes whatever action is passed to `fire()`
    this.breaker = new CircuitBreaker(
      (action: () => Promise<unknown>) => action(),
      {
        errorThresholdPercentage: mergedOptions.errorThresholdPercentage,
        resetTimeout: mergedOptions.resetTimeout,
        timeout: mergedOptions.timeout,
      },
    );

    this.breaker.on("open", () => {
      this.logger.warn({
        action: "circuit_breaker.state_change",
        circuitState: "open",
      });
    });

    this.breaker.on("close", () => {
      this.logger.warn({
        action: "circuit_breaker.state_change",
        circuitState: "closed",
      });
    });

    this.breaker.on("halfOpen", () => {
      this.logger.warn({
        action: "circuit_breaker.state_change",
        circuitState: "half-open",
      });
    });
  }

  async fire<T>(action: () => Promise<T>): Promise<T> {
    return this.breaker.fire(action) as Promise<T>;
  }
}
