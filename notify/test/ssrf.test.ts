import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { assertPublicHostname, isPrivateIp, validatePublicHttpsUrl, type LookupAddress } from "../src/ssrf.ts";

describe("isPrivateIp", () => {
  test("flags loopback, private, link-local, and reserved IPv4", () => {
    for (const ip of [
      "0.0.0.0", "10.0.0.5", "127.0.0.1", "100.64.0.1", "169.254.1.1",
      "172.16.0.1", "172.31.255.255", "192.0.0.1", "192.0.2.1", "192.168.1.1",
      "198.18.0.1", "198.51.100.1", "203.0.113.1", "224.0.0.1", "255.255.255.255",
    ]) {
      assert.equal(isPrivateIp(ip), true, ip);
    }
  });

  test("allows public IPv4", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "192.169.0.1", "11.0.0.1", "223.255.255.255"]) {
      assert.equal(isPrivateIp(ip), false, ip);
    }
  });

  test("flags loopback, unique-local, link-local, and mapped IPv6", () => {
    assert.equal(isPrivateIp("::1"), true);
    assert.equal(isPrivateIp("::"), true);
    assert.equal(isPrivateIp("fc00::1"), true);
    assert.equal(isPrivateIp("fd12::ab"), true);
    assert.equal(isPrivateIp("fe80::1"), true);
    assert.equal(isPrivateIp("::ffff:127.0.0.1"), true);
    assert.equal(isPrivateIp("::ffff:192.168.0.1"), true);
    assert.equal(isPrivateIp("2606:4700:4700::1111"), false);
  });

  test("non-IP strings are not flagged here", () => {
    assert.equal(isPrivateIp("ntfy.sh"), false);
  });
});

describe("validatePublicHttpsUrl", () => {
  test("accepts a plain public https URL", () => {
    const result = validatePublicHttpsUrl("https://ntfy.sh");
    assert.ok(result.ok);
    assert.equal(result.url.origin, "https://ntfy.sh");
  });

  test("rejects non-https schemes", () => {
    for (const raw of ["http://ntfy.sh", "ftp://example.com", "file:///etc/passwd"]) {
      const result = validatePublicHttpsUrl(raw);
      assert.equal(result.ok, false, raw);
      if (!result.ok) assert.match(result.reason, /https/);
    }
  });

  test("rejects invalid URLs and embedded credentials", () => {
    assert.equal(validatePublicHttpsUrl("not a url").ok, false);
    const creds = validatePublicHttpsUrl("https://user:pass@ntfy.sh");
    assert.equal(creds.ok, false);
    if (!creds.ok) assert.match(creds.reason, /credentials/);
  });

  test("rejects localhost and local-suffix hostnames", () => {
    for (const raw of ["https://localhost", "https://api.localhost", "https://printer.local", "https://db.internal"]) {
      assert.equal(validatePublicHttpsUrl(raw).ok, false, raw);
    }
  });

  test("rejects private IP literals", () => {
    for (const raw of ["https://127.0.0.1", "https://10.1.2.3", "https://192.168.0.1", "https://[::1]", "https://[fd00::1]"]) {
      assert.equal(validatePublicHttpsUrl(raw).ok, false, raw);
    }
    assert.equal(validatePublicHttpsUrl("https://8.8.8.8").ok, true);
  });
});

describe("assertPublicHostname", () => {
  const lookupReturning = (addresses: LookupAddress[]) => async () => addresses;

  test("passes when all resolved addresses are public", async () => {
    const url = new URL("https://ntfy.sh");
    await assertPublicHostname(url, lookupReturning([{ address: "104.26.0.1", family: 4 }]));
  });

  test("rejects when any resolved address is private", async () => {
    const url = new URL("https://ntfy.sh");
    await assert.rejects(
      () => assertPublicHostname(url, lookupReturning([
        { address: "104.26.0.1", family: 4 },
        { address: "10.0.0.8", family: 4 },
      ])),
      /private\/reserved/,
    );
  });

  test("rejects DNS failures and empty answers", async () => {
    const url = new URL("https://ntfy.sh");
    await assert.rejects(() => assertPublicHostname(url, async () => {
      throw new Error("ENOTFOUND");
    }), /DNS resolution failed/);
    await assert.rejects(() => assertPublicHostname(url, lookupReturning([])), /no addresses/);
  });

  test("checks IP literals without a lookup", async () => {
    let lookups = 0;
    const countingLookup = async (): Promise<LookupAddress[]> => {
      lookups += 1;
      return [];
    };
    await assertPublicHostname(new URL("https://8.8.8.8"), countingLookup);
    assert.equal(lookups, 0);
    await assert.rejects(() => assertPublicHostname(new URL("https://127.0.0.1"), countingLookup), /private\/reserved/);
    assert.equal(lookups, 0);
  });
});
