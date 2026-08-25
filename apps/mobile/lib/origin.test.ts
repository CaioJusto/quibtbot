import { describe, expect, it } from "vitest";
import { billingReturnUrl } from "./origin";

describe("billingReturnUrl", () => {
  it("sends Stripe back to the web billing page with an app return", () => {
    expect(billingReturnUrl("success")).toContain("/billing?billing=success&app=1");
  });
});
