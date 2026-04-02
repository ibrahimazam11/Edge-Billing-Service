import { IS_PUBLIC_KEY, Public } from "./public.decorator";

describe("Public decorator", () => {
  it("should set IS_PUBLIC_KEY metadata to true", () => {
    @Public()
    class TestController {}

    const metadata = Reflect.getMetadata(IS_PUBLIC_KEY, TestController);
    expect(metadata).toBe(true);
  });
});
