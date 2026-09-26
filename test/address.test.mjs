import "./helpers/no-network.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { checkAddress } from "../src/address.mjs";

test("private, loopback, link-local, metadata and other special addresses are refused, IPv4 and IPv6", () => {
  const refused = [
    ["127.0.0.1", /loopback/],
    ["127.8.9.10", /loopback/],
    ["10.1.2.3", /private/],
    ["172.16.0.1", /private/],
    ["172.31.255.255", /private/],
    ["192.168.1.1", /private/],
    ["169.254.169.254", /cloud metadata/],
    ["169.254.170.2", /cloud metadata/],
    ["100.100.100.200", /cloud metadata/],
    ["169.254.10.10", /link-local/],
    ["100.64.0.1", /carrier-grade/],
    ["0.0.0.0", /reserved/],
    ["224.0.0.1", /multicast/],
    ["255.255.255.255", /broadcast/],
    ["::1", /loopback/],
    ["::", /unspecified/],
    ["[::1]", /loopback/],
    ["fe80::1", /link-local/],
    ["fe80::1%eth0", /link-local/],
    ["fc00::1", /private/],
    ["fd12:3456::1", /private/],
    ["fd00:ec2::254", /cloud metadata/],
    ["::ffff:127.0.0.1", /loopback/],
    ["::ffff:7f00:1", /loopback/],
    ["::ffff:169.254.169.254", /cloud metadata/],
    ["64:ff9b::a9fe:a9fe", /cloud metadata/],
    ["64:ff9b::10.0.0.1", /private/],
    ["2002:0a00:0001::1", /private/],
    ["2001:db8::1", /documentation/],
    ["ff02::1", /multicast/],
    ["localhost", /not an IP address/],
  ];
  for (const [address, reason] of refused) {
    const result = checkAddress(address);
    assert.equal(result.allowed, false, address);
    assert.match(result.reason, reason, address);
  }
});

test("public addresses are allowed", () => {
  for (const address of ["93.184.215.14", "8.8.8.8", "172.32.0.1", "100.128.0.1", "2606:4700:4700::1111", "2001:4860:4860::8888", "::ffff:8.8.8.8"]) {
    assert.deepEqual(checkAddress(address), { allowed: true }, address);
  }
});
