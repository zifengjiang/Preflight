import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * The SNI hostname validator used in handleConnectEvent:
 * /^[a-z0-9.\-]+$/i  — valid DNS charset only.
 * Hostnames that fail this check fall through to a blind tunnel
 * rather than reaching generateServerCert's openssl execSync.
 */
const isSafeHostname = (hostname: string): boolean => /^[a-z0-9.\-]+$/i.test(hostname);

test("SNI validator accepts well-formed hostnames", () => {
  assert.ok(isSafeHostname("api.example.com"));
  assert.ok(isSafeHostname("localhost"));
  assert.ok(isSafeHostname("sub.api.example.com"));
  assert.ok(isSafeHostname("192.168.1.1"));
  assert.ok(isSafeHostname("my-host.example.org"));
});

test("SNI validator rejects hostnames containing shell metacharacters", () => {
  assert.equal(isSafeHostname("evil$(cmd)"), false);
  assert.equal(isSafeHostname("a;b"), false);
  assert.equal(isSafeHostname("host`whoami`"), false);
  assert.equal(isSafeHostname("x|y"), false);
  assert.equal(isSafeHostname("a>b"), false);
  assert.equal(isSafeHostname("a&b"), false);
});

test("SNI validator rejects hostnames with spaces or quotes", () => {
  assert.equal(isSafeHostname("my host"), false);
  assert.equal(isSafeHostname("host\"x\""), false);
  assert.equal(isSafeHostname("host'x'"), false);
});
