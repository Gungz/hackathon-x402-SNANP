import { test, describe } from "node:test";
import assert from "node:assert";
import { isDomainAllowed, isUrlAllowed, extractHostname, ALLOWED_DOMAINS } from "../../src/allowlist";

describe("allowlist", () => {
  test("accepts allowlisted domains", () => {
    assert.equal(isDomainAllowed("espn.com"), true);
    assert.equal(isDomainAllowed("www.espn.com"), true);
    assert.equal(isDomainAllowed("bbc.com"), true);
  });

  test("rejects non-allowlisted domains", () => {
    assert.equal(isDomainAllowed("evil.com"), false);
    assert.equal(isDomainAllowed("bbc.com.evil.com"), false);
  });

  test("URL allowlisting works", () => {
    assert.equal(isUrlAllowed("https://www.espn.com/soccer/match"), true);
    assert.equal(isUrlAllowed("https://evil.com/article"), false);
  });

  test("extractHostname handles invalid URLs", () => {
    assert.equal(extractHostname("not-a-url"), null);
    assert.equal(extractHostname("https://espn.com/x"), "espn.com");
  });

  test("ALLOWED_DOMAINS is non-empty and lowercased", () => {
    assert.ok(ALLOWED_DOMAINS.length > 0);
    for (const d of ALLOWED_DOMAINS) {
      assert.equal(d, d.toLowerCase());
    }
  });
});
