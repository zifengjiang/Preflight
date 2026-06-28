import { test } from "node:test";
import assert from "node:assert/strict";
import { isRootableAdbOutput } from "../mcp/network-mocks/device-ca.ts";

// Production-build refusal — NOT rootable
test("isRootableAdbOutput: returns false for production-build refusal", () => {
  assert.equal(isRootableAdbOutput("adbd cannot run as root in production builds"), false);
});

test("isRootableAdbOutput: returns false for production refusal with trailing newline", () => {
  assert.equal(isRootableAdbOutput("adbd cannot run as root in production builds\n"), false);
});

// Successful root — IS rootable
test("isRootableAdbOutput: returns true for restarting adbd as root", () => {
  assert.equal(isRootableAdbOutput("restarting adbd as root"), true);
});

test("isRootableAdbOutput: returns true for already running as root", () => {
  assert.equal(isRootableAdbOutput("adbd is already running as root"), true);
});

test("isRootableAdbOutput: returns true for 'already running as root' variant", () => {
  assert.equal(isRootableAdbOutput("already running as root"), true);
});

// Unknown output — treated as not-confirmed-rootable (false)
test("isRootableAdbOutput: returns false for empty string (unknown)", () => {
  assert.equal(isRootableAdbOutput(""), false);
});

test("isRootableAdbOutput: returns false for unrecognized output (unknown)", () => {
  assert.equal(isRootableAdbOutput("error: device unauthorized"), false);
});
