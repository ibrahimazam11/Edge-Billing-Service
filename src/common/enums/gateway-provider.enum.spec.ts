import { GatewayProvider } from "./gateway-provider.enum";

describe("GatewayProvider", () => {
  it("should have Stripe value as 'stripe'", () => {
    expect(GatewayProvider.Stripe).toBe("stripe");
  });

  it("should have Adyen value as 'adyen'", () => {
    expect(GatewayProvider.Adyen).toBe("adyen");
  });

  it("should have exactly two members", () => {
    const values = Object.values(GatewayProvider);
    expect(values).toHaveLength(2);
    expect(values).toEqual(["stripe", "adyen"]);
  });
});
