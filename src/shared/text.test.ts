import { describe, expect, it } from "vitest";

import {
  canonicalTerm,
  compareStrings,
  expandQueryTerm,
  identifierVariants,
  isStopword,
  stripStopwords,
  tokenizeIdentifier,
} from "./text";

describe("identifier tokenization", () => {
  it("splits camelCase", () => {
    expect(tokenizeIdentifier("rateLimit")).toEqual(["rate", "limit"]);
  });

  it("splits PascalCase", () => {
    expect(tokenizeIdentifier("RateLimiter")).toEqual(["rate", "limiter"]);
  });

  it("splits snake_case and kebab-case", () => {
    expect(tokenizeIdentifier("rate_limiting")).toEqual(["rate", "limiting"]);
    expect(tokenizeIdentifier("rate-limiting")).toEqual(["rate", "limiting"]);
  });

  it("splits dotted and slashed identifiers", () => {
    expect(tokenizeIdentifier("auth.service.ts")).toEqual(["auth", "service", "ts"]);
  });

  it("handles consecutive capitals", () => {
    expect(tokenizeIdentifier("parseHTMLString")).toEqual(["parse", "html", "string"]);
  });
});

describe("canonical forms", () => {
  it("treats casing/separator variants as related", () => {
    const variants = ["rate-limiting", "rate_limit", "rateLimit", "RateLimiter"].map(canonicalTerm);
    for (const variant of variants) {
      expect(variant.startsWith("rate")).toBe(true);
    }
    expect(canonicalTerm("RateLimiter")).toBe(canonicalTerm("rateLimiter"));
  });

  it("identifierVariants yields joined/snake/kebab forms", () => {
    expect(identifierVariants("rateLimit")).toEqual(["ratelimit", "rate_limit", "rate-limit"]);
  });
});

describe("stopwords", () => {
  it("strips generic task words", () => {
    expect(stripStopwords(["add", "rate", "limiting"])).toEqual(["rate", "limiting"]);
  });

  it("keeps domain words", () => {
    expect(isStopword("authentication")).toBe(false);
    expect(isStopword("pagination")).toBe(false);
  });
});

describe("compareStrings", () => {
  it("is a stable total order", () => {
    expect(compareStrings("a", "b")).toBeLessThan(0);
    expect(compareStrings("b", "a")).toBeGreaterThan(0);
    expect(compareStrings("a", "a")).toBe(0);
  });
});

describe("expandQueryTerm", () => {
  it("returns canonical plus tokens", () => {
    expect(expandQueryTerm("RateLimit")).toEqual({
      canonical: "ratelimit",
      tokens: ["rate", "limit"],
    });
  });
});
