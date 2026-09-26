// Which IP addresses the tool may connect to. Private, loopback, link-local, cloud metadata and other
// special-purpose ranges are refused, for IPv4 and IPv6, including IPv4 addresses carried inside IPv6 forms
// (IPv4-mapped, NAT64 and 6to4), so a hostname cannot point the tool at a machine inside your network.
import net from "node:net";

const METADATA = "a cloud metadata address";
const METADATA_V4 = new Set(["169.254.169.254", "169.254.170.2", "100.100.100.200"]);

function v4ToNumber(text) {
  return text.split(".").reduce((value, part) => value * 256 + Number(part), 0);
}

// [first address, prefix length, why it is refused]
const V4_RANGES = [
  ["0.0.0.0", 8, "a reserved address"],
  ["10.0.0.0", 8, "a private address"],
  ["100.64.0.0", 10, "a shared (carrier-grade NAT) address"],
  ["127.0.0.0", 8, "a loopback address"],
  ["169.254.0.0", 16, "a link-local address"],
  ["172.16.0.0", 12, "a private address"],
  ["192.0.0.0", 24, "a reserved address"],
  ["192.0.2.0", 24, "a documentation address"],
  ["192.168.0.0", 16, "a private address"],
  ["198.18.0.0", 15, "a benchmarking address"],
  ["198.51.100.0", 24, "a documentation address"],
  ["203.0.113.0", 24, "a documentation address"],
  ["224.0.0.0", 4, "a multicast address"],
  ["240.0.0.0", 4, "a reserved or broadcast address"],
].map(([first, bits, reason]) => ({ first: v4ToNumber(first), size: 2 ** (32 - bits), reason }));

function checkV4(text) {
  if (METADATA_V4.has(text)) return { allowed: false, reason: METADATA };
  const value = v4ToNumber(text);
  for (const range of V4_RANGES) {
    if (value >= range.first && value < range.first + range.size) return { allowed: false, reason: range.reason };
  }
  return { allowed: true };
}

/** The eight 16-bit groups of an IPv6 address (zone removed, embedded IPv4 converted), or null. */
function v6Groups(text) {
  let s = text.toLowerCase();
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  const lastColon = s.lastIndexOf(":");
  const tail = s.slice(lastColon + 1);
  if (tail.includes(".")) {
    if (!net.isIPv4(tail)) return null;
    const value = v4ToNumber(tail);
    s = `${s.slice(0, lastColon + 1)}${Math.floor(value / 65536).toString(16)}:${(value % 65536).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  const groups = [...left, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...right].map((g) => Number.parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

function embeddedV4(groups, at) {
  return [groups[at] >> 8, groups[at] & 255, groups[at + 1] >> 8, groups[at + 1] & 255].join(".");
}

function checkV6(text) {
  const g = v6Groups(text);
  if (!g) return { allowed: false, reason: "an address the tool cannot read" };
  const zeros = (from, to) => g.slice(from, to).every((x) => x === 0);
  if (zeros(0, 8)) return { allowed: false, reason: "the unspecified address" };
  if (zeros(0, 7) && g[7] === 1) return { allowed: false, reason: "a loopback address" };
  if (zeros(0, 5) && g[5] === 0xffff) return checkV4(embeddedV4(g, 6)); // ::ffff:a.b.c.d
  if (zeros(0, 6)) return { allowed: false, reason: "an IPv4-compatible address" };
  if (g[0] === 0x64 && g[1] === 0xff9b && zeros(2, 6)) return checkV4(embeddedV4(g, 6)); // NAT64
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1) return { allowed: false, reason: "a local NAT64 address" };
  if (g[0] === 0x100 && zeros(1, 4)) return { allowed: false, reason: "a discard-only address" };
  if (g[0] === 0x2001 && g[1] === 0xdb8) return { allowed: false, reason: "a documentation address" };
  if (g[0] === 0x2001 && g[1] === 0) return { allowed: false, reason: "a Teredo tunnel address" };
  if (g[0] === 0x2002) return checkV4(embeddedV4(g, 1)); // 6to4
  if (g[0] === 0xfd00 && g[1] === 0xec2 && zeros(2, 7) && g[7] === 0x254) return { allowed: false, reason: METADATA };
  if ((g[0] & 0xfe00) === 0xfc00) return { allowed: false, reason: "a private (unique local) address" };
  if ((g[0] & 0xffc0) === 0xfe80) return { allowed: false, reason: "a link-local address" };
  if ((g[0] & 0xffc0) === 0xfec0) return { allowed: false, reason: "a site-local address" };
  if (g[0] >> 8 === 0xff) return { allowed: false, reason: "a multicast address" };
  return { allowed: true };
}

/** { allowed: true } for a public address; otherwise { allowed: false, reason } with a phrase such as "a private address". */
export function checkAddress(address) {
  const text = String(address ?? "").trim();
  const bare = text.replace(/^\[|\]$/g, "");
  if (net.isIPv4(bare)) return checkV4(bare);
  if (net.isIPv6(bare.split("%")[0])) return checkV6(bare);
  return { allowed: false, reason: "not an IP address" };
}
