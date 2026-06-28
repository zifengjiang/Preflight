import { test } from "node:test";
import assert from "node:assert/strict";
import { ensureCaInstalled, computeAndroidHash } from "../mcp/network-mocks/device-ca.ts";

const FAKE_HASH = "abcd1234";
const SERIAL = "emulator-5554";
const CA_PEM_PATH = "/tmp/fake-ca.pem";
const USER_TARGET = `/data/misc/user/0/cacerts-added/${FAKE_HASH}.0`;
const TMP_TARGET = `/data/local/tmp/${FAKE_HASH}.0`;

function makeRunner(responses: Map<string, string> = new Map()): { run: (cmd: string, args: string[]) => Promise<string>; calls: [string, string[]][] } {
  const calls: [string, string[]][] = [];
  const run = async (cmd: string, args: string[]): Promise<string> => {
    calls.push([cmd, args]);
    const key = [cmd, ...args].join(" ");
    return responses.get(key) ?? "";
  };
  return { run, calls };
}

test("computeAndroidHash calls openssl with correct args", async () => {
  const { run, calls } = makeRunner(new Map([
    [`openssl x509 -inform PEM -subject_hash_old -noout -in ${CA_PEM_PATH}`, `${FAKE_HASH}\n`],
  ]));
  const hash = await computeAndroidHash(CA_PEM_PATH, run);
  assert.equal(hash, FAKE_HASH);
  assert.equal(calls[0][0], "openssl");
  assert.deepEqual(calls[0][1], ["x509", "-inform", "PEM", "-subject_hash_old", "-noout", "-in", CA_PEM_PATH]);
});

test("ensureCaInstalled (fresh install, user store): runs adb root + wait + push + shell sequence", async () => {
  // ls returns empty (file not present)
  const responses = new Map([
    [`openssl x509 -inform PEM -subject_hash_old -noout -in ${CA_PEM_PATH}`, `${FAKE_HASH}\n`],
    // verify ls after install: returns the hash (file present)
    [`adb -s ${SERIAL} shell ls ${USER_TARGET} 2>/dev/null || true`, `${USER_TARGET}\n`],
  ]);
  const { run, calls } = makeRunner(responses);
  // First ls (idempotency check) returns empty — file not there yet
  // We override the runner to return hash only on the second ls call
  let lsCallCount = 0;
  const smartRun = async (cmd: string, args: string[]): Promise<string> => {
    const key = [cmd, ...args].join(" ");
    if (cmd === "adb" && args.includes("shell") && args.some(a => a.includes("ls") && a.includes("cacerts-added"))) {
      lsCallCount++;
      if (lsCallCount === 1) return ""; // first call: file not present
      return `${USER_TARGET}\n`; // second call: verify after install
    }
    if (cmd === "openssl") return `${FAKE_HASH}\n`;
    return responses.get(key) ?? "";
  };
  const smartCalls: [string, string[]][] = [];
  const wrappedRun = async (cmd: string, args: string[]): Promise<string> => {
    smartCalls.push([cmd, args]);
    return smartRun(cmd, args);
  };

  const result = await ensureCaInstalled({ serial: SERIAL, caPemPath: CA_PEM_PATH }, wrappedRun);

  // adb root then wait-for-device
  const adbCalls = smartCalls.filter(([c]) => c === "adb");
  assert.equal(adbCalls[0][1].join(" "), `-s ${SERIAL} root`);
  assert.equal(adbCalls[1][1].join(" "), `-s ${SERIAL} wait-for-device`);

  // push to tmp
  const pushCall = adbCalls.find(([, args]) => args.includes("push"));
  assert.ok(pushCall, "push call must exist");
  assert.deepEqual(pushCall![1], ["-s", SERIAL, "push", CA_PEM_PATH, TMP_TARGET]);

  // shell cp + chmod + chown + restorecon
  const shellInstallCall = adbCalls.find(([, args]) => args.includes("shell") && args.some(a => a.includes("cp") && a.includes("cacerts-added")));
  assert.ok(shellInstallCall, "shell cp install call must exist");
  const shellCmd = shellInstallCall![1].find(a => a.includes("cp"))!;
  assert.ok(shellCmd.includes("chmod 644"), "must chmod 644");
  assert.ok(shellCmd.includes("chown system:system"), "must chown system:system");
  assert.ok(shellCmd.includes("restorecon"), "must restorecon");
  assert.ok(shellCmd.includes(USER_TARGET), "must target user store path");

  assert.equal(result.store, "user");
  assert.equal(result.already, false);
  assert.equal(result.installed, true);
});

test("ensureCaInstalled idempotency: skips push when cert already present", async () => {
  const smartCalls: [string, string[]][] = [];
  const run = async (cmd: string, args: string[]): Promise<string> => {
    smartCalls.push([cmd, args]);
    if (cmd === "openssl") return `${FAKE_HASH}\n`;
    // ls returns the hash — file is already present
    if (cmd === "adb" && args.includes("shell") && args.some(a => a.includes("ls") && a.includes("cacerts-added"))) {
      return `${USER_TARGET}\n`;
    }
    return "";
  };

  const result = await ensureCaInstalled({ serial: SERIAL, caPemPath: CA_PEM_PATH }, run);

  // no push call
  const pushCall = smartCalls.find(([c, args]) => c === "adb" && args.includes("push"));
  assert.ok(!pushCall, "must NOT push when already installed");

  assert.equal(result.store, "user");
  assert.equal(result.already, true);
  assert.equal(result.installed, true);
});

test("ensureCaInstalled system store: runs remount + push + chmod", async () => {
  const SYS_TARGET = `/system/etc/security/cacerts/${FAKE_HASH}.0`;
  const calls: [string, string[]][] = [];
  const run = async (cmd: string, args: string[]): Promise<string> => {
    calls.push([cmd, args]);
    if (cmd === "openssl") return `${FAKE_HASH}\n`;
    // verify ls returns the file
    if (cmd === "adb" && args.includes("shell") && args.some(a => a.includes("ls") && a.includes("cacerts"))) {
      return `${SYS_TARGET}\n`;
    }
    return "";
  };

  const result = await ensureCaInstalled({ serial: SERIAL, caPemPath: CA_PEM_PATH, mode: "system" }, run);

  const adbCalls = calls.filter(([c]) => c === "adb");
  const remountCall = adbCalls.find(([, args]) => args.includes("remount"));
  assert.ok(remountCall, "must remount for system store");

  const pushCall = adbCalls.find(([, args]) => args.includes("push"));
  assert.ok(pushCall, "push call must exist");
  assert.deepEqual(pushCall![1], ["-s", SERIAL, "push", CA_PEM_PATH, SYS_TARGET]);

  const chmodCall = adbCalls.find(([, args]) => args.includes("shell") && args.some(a => a.includes("chmod")));
  assert.ok(chmodCall, "chmod must be called");

  assert.equal(result.store, "system");
  assert.equal(result.already, false);
  assert.equal(result.installed, true);
});
