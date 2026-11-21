// Where a link carried by the Remote may go (relay.ts carries it): the whole of that judgement, and nothing that
// touches a socket. A link is asked for by one line, as cowboy writes it (ricebox/cowboy/src/frame.rs): a name or an
// IPv4 address in dots, a colon, a port, the end of the line.
//
//   who         a session, asked from one of the app's own pages or by a device's token (relay.ts admit)
//   to where    a port of PORTS, at a public IPv4 address: one given as it stands, or every address a name has
//               (a name with one address that is not public is refused whole: no answer picks which is dialled)
//   dialled     by the address that was judged, never by the name again, so what was judged is what is reached
//
// Nothing here is kept, and nothing is written anywhere: a link costs the Remote one look at a session.

/** The ports a link may be to: the web's two and SSH's. */
export const PORTS: readonly number[] = [80, 443, 22];

/** Why a link is not made, as Linux numbers it: what the program in the box is told by its connect(). */
export const ERR = {
  /** Not allowed: the port, or an address that is not public. */
  ACCES: 13,
  /** No way there from here (the Remote's own network refuses the address). */
  NETUNREACH: 101,
  /** Too many links of this account at once. */
  NOBUFS: 105,
  /** No answer in time. */
  TIMEDOUT: 110,
  /** Refused by the host. */
  REFUSED: 111,
  /** No such host: the name has no address. */
  HOSTUNREACH: 113,
} as const;

/** The longest a first line is (cowboy's LINE): a name of 253 bytes, a colon, a port's five digits, the end of the line. */
export const LINE = 253 + 1 + 5 + 1;

/** An IPv4 address, its four parts. */
export type Address = [number, number, number, number];
/** What a first line asks for. */
export type Asked = {name: string; port: number} | {address: Address; port: number};

/** A whole number written in digits and nothing else, no zero before it, at most `most`; else -1. */
function number(text: string, most: number): number {
  if (!/^(0|[1-9][0-9]{0,4})$/.test(text)) return -1;
  const n = Number(text);
  return n <= most ? n : -1;
}

/** `text` as an IPv4 address in dots (four parts, each written as cowboy writes it), or null. */
export function addressOf(text: string): Address | null {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  const a = parts.map((p) => number(p, 255));
  return a.includes(-1) ? null : a as Address;
}

/**
 * Whether `name` is a host's name as DNS has them and cowboy passes them: lower case letters, digits and hyphens in
 * labels of 1 to 63 between dots, 253 at most in all, two labels at least, the last not a number (so nothing that
 * some resolver would read as an address in another form is ever asked as a name).
 */
export function isName(name: string): boolean {
  if (name.length > 253) return false;
  const labels = name.split('.');
  if (labels.length < 2) return false;
  for (const l of labels) if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(l)) return false;
  return !/^[0-9]+$/.test(labels[labels.length - 1]);
}

/** What a first line asks for, or null where it is not one: `name:port\n` or `a.b.c.d:port\n`, whole. */
export function asked(line: Uint8Array): Asked | null {
  if (line.length < 4 || line.length > LINE || line[line.length - 1] !== 10) return null;
  let text = '';
  for (let i = 0; i < line.length - 1; i++) {
    // Letters anyone reads, and none that ends a line or is not one.
    if (line[i] < 0x21 || line[i] > 0x7e) return null;
    text += String.fromCharCode(line[i]);
  }
  const at = text.lastIndexOf(':');
  if (at < 1) return null;
  const host = text.slice(0, at), port = number(text.slice(at + 1), 65535);
  if (port < 1) return null;
  const address = addressOf(host);
  if (address) return {address, port};
  return isName(host) ? {name: host, port} : null;
}

/** Whether an address is in one of the blocks of `list`, each `a.b.c.d/bits`. */
export function blocks(list: readonly string[]): (a: Address) => boolean {
  const made = list.map((text): [number, number] => {
    const [first, bits] = text.split('/'), a = addressOf(first)!;
    return [((a[0] << 24) | (a[1] << 16) | (a[2] << 8) | a[3]) >>> 0, 32 - Number(bits)];
  });
  return (a) => {
    const n = ((a[0] << 24) | (a[1] << 16) | (a[2] << 8) | a[3]) >>> 0;
    for (const [block, rest] of made) if ((n >>> rest) === (block >>> rest)) return true;
    return false;
  };
}

/**
 * The IPv4 blocks that are not a host on the public Internet: IANA's special-purpose registry (RFC 6890), and what
 * is not unicast.
 */
const kept = blocks(['0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12', '192.0.0.0/24', '192.0.2.0/24',
  '192.88.99.0/24', '192.168.0.0/16', '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24', '224.0.0.0/4', '240.0.0.0/4']);

/** Whether `a` is a host on the public Internet: in none of the blocks kept for something else. */
export const isPublic = (a: Address): boolean => !kept(a);

/** The IPv4 addresses a name has (its A records), as DNS answers now; none where it has none. */
export type Resolve = (name: string) => Promise<string[]>;

/** May a link go there: asked of the port first (a name is not asked of anyone for a link that would not be made), then of each address. */
export interface Rule { port(port: number): boolean; address(address: Address, port: number): boolean }
/** The rule: a port of PORTS, at a public address. */
export const RULE: Rule = {port: (port) => PORTS.includes(port), address: (address) => isPublic(address)};
/**
 * RULE, and besides it the places named, each `a.b.c.d:port`: for a Remote on this machine alone (serve/dev.ts),
 * through which a test reaches a server of its own. The Worker has no such word.
 */
export function also(places: string[]): Rule {
  const named = new Set(places);
  return {port: (port) => RULE.port(port) || places.some((p) => p.endsWith(`:${port}`)),
    address: (address, port) => named.has(`${address.join('.')}:${port}`) || (RULE.port(port) && RULE.address(address, port))};
}

/**
 * Where a link asked for is dialled: the address, in dots; or why it is not (ERR). A name is asked of `resolve`
 * once, and every address it has must be one a link may go to.
 */
export async function where(a: Asked, resolve: Resolve, rule: Rule = RULE): Promise<{address: string} | {errno: number}> {
  if (!rule.port(a.port)) return {errno: ERR.ACCES};
  if ('address' in a) return rule.address(a.address, a.port) ? {address: a.address.join('.')} : {errno: ERR.ACCES};
  let found: string[];
  try { found = await resolve(a.name); } catch { return {errno: ERR.HOSTUNREACH}; }
  const addresses = found.map(addressOf);
  if (!addresses.length || addresses.includes(null)) return {errno: ERR.HOSTUNREACH};
  for (const address of addresses) if (!rule.address(address!, a.port)) return {errno: ERR.ACCES};
  return {address: addresses[0]!.join('.')};
}

/** How long a name's addresses are taken as still its own by this process, and how many names are kept. */
const KEPT_MS = 60_000, KEPT_MOST = 256;

/**
 * A name's A records over HTTPS (RFC 8484's JSON, as the Remote reads a domain's TXT: talk/inbox.ts), kept a minute
 * a name: a page's links are mostly to the same few hosts, and each asked again would be a request each.
 */
export function overHttps(f: typeof fetch = fetch, now: () => number = Date.now): Resolve {
  const kept = new Map<string, {until: number; addresses: string[]}>();
  return async (name) => {
    const had = kept.get(name);
    if (had && had.until > now()) return had.addresses;
    const r = await f(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=A`,
      {headers: {accept: 'application/dns-json'}, signal: AbortSignal.timeout(5000)});
    if (!r.ok) throw new Error(`DNS ${r.status}`);
    const answer = (await r.json()) as {Status?: number; Answer?: {type: number; data: string}[]};
    // Its A records alone (a CNAME on the way is the resolver's to follow, and it has).
    const addresses = answer.Status === 0 ? (answer.Answer ?? []).filter((x) => x.type === 1).map((x) => x.data) : [];
    if (kept.size >= KEPT_MOST) kept.clear();
    kept.set(name, {until: now() + KEPT_MS, addresses});
    return addresses;
  };
}
