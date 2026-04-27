import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHash, createHmac } from "crypto";
import type { PayrollEmployeeLineItem } from "../sqs/contracts/inbound-events";

export interface PayrollBreakdownResponse {
  employees: PayrollEmployeeLineItem[];
  totalAmountCents: number;
}

@Injectable()
export class MonolithApiService {
  private readonly logger = new Logger(MonolithApiService.name);
  private readonly baseUrl: string | undefined;
  private readonly apiKey: string | undefined;
  private readonly hmacSecret: string | undefined;

  constructor(private readonly configService: ConfigService) {
    this.baseUrl = this.configService.get<string>("monolith.baseUrl");
    this.apiKey = this.configService.get<string>("monolith.apiKey");
    this.hmacSecret = this.configService.get<string>("monolith.hmacSecret");
  }

  async getPayrollBreakdown(
    monolithCustomerId: string,
    cycle?: { start: Date; end: Date },
  ): Promise<PayrollBreakdownResponse> {
    if (!this.baseUrl) {
      throw new Error("MONOLITH_API_BASE_URL not configured");
    }

    // Sign with the bare path (no query string). Monolith's middleware
    // validates against `req.path`, which excludes the query string.
    const path = `/v1/billing-service/customers/${monolithCustomerId}/payroll-breakdown`;
    const qs = cycle
      ? `?${new URLSearchParams({
          cycleStart: cycle.start.toISOString(),
          cycleEnd: cycle.end.toISOString(),
        }).toString()}`
      : "";
    const url = `${this.baseUrl}${path}${qs}`;
    const headers = this.sign("GET", path);

    const response = await fetch(url, { headers });

    if (!response.ok) {
      const body = await response.text();
      this.logger.error({
        message: "Monolith API call failed",
        url,
        status: response.status,
        body,
      });
      throw new Error(
        `Monolith API error: ${response.status} ${response.statusText}`,
      );
    }

    return (await response.json()) as PayrollBreakdownResponse;
  }

  private sign(
    method: string,
    path: string,
    body?: unknown,
  ): Record<string, string> {
    if (!this.apiKey || !this.hmacSecret) {
      throw new Error("Monolith API auth not configured");
    }

    const timestamp = Date.now().toString();
    const bodyStr = body ? JSON.stringify(body) : "";
    const bodyHash = createHash("sha256").update(bodyStr).digest("hex");
    const payload = method.toUpperCase() + path + timestamp + bodyHash;
    const signature = createHmac("sha256", this.hmacSecret)
      .update(payload)
      .digest("hex");

    return {
      "x-api-key": this.apiKey,
      "x-timestamp": timestamp,
      "x-signature": signature,
      "Content-Type": "application/json",
    };
  }
}
