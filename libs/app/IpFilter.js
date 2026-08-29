'use strict';

// ── IpFilter — shared IP allow/deny matching ─────────────────────────────────
//
// One dependency-free matcher used at all three layers of SymBot's IP filtering:
//   1. server-wide (before auth), 2. login / session, 3. per API key.
//
// Supports exact IPv4 and IPv6 addresses and CIDR ranges for both families
// (e.g. `10.0.0.0/8`, `2001:db8::/32`). IPv4-mapped IPv6 (`::ffff:1.2.3.4`) is
// normalized to its IPv4 form, and an IPv6 zone id (`fe80::1%eth0`) is stripped,
// so an address compares equal regardless of the form it arrives in (important
// behind NGINX/Apache/Cloudflare, which is where the client IP is read from).
//
// Rule of evaluation: a DENY (blocklist) match always wins over an ALLOW match;
// an empty allowlist means "allow everything" (subject to the blocklist). The
// server-wide and login layers additionally treat loopback as always-allowed so
// a misconfiguration can never lock a user out of local / console access.

// Strip zone id and IPv4-mapped IPv6 prefix; trim + lowercase. Returns '' for junk.
function normalizeIp(ip) {

	let out = '';

	if (typeof ip === 'string') {

		let s = ip.trim().toLowerCase();

		// Drop an IPv6 zone identifier (e.g. fe80::1%eth0).
		const pct = s.indexOf('%');
		if (pct > -1) { s = s.slice(0, pct); }

		// IPv4-mapped IPv6 → bare IPv4.
		if (s.startsWith('::ffff:') && s.indexOf('.') > -1) { s = s.slice('::ffff:'.length); }

		out = s;
	}

	return out;
}


// Parse an IPv4 string to a BigInt (0 .. 2^32-1) or null.
function ipv4ToBig(s) {

	let result = null;

	const parts = s.split('.');

	if (parts.length === 4) {

		let ok = true;
		let n = 0n;

		for (const p of parts) {

			if (!/^\d{1,3}$/.test(p)) { ok = false; break; }
			const v = Number(p);
			if (v > 255) { ok = false; break; }
			n = (n << 8n) + BigInt(v);
		}

		if (ok) { result = n; }
	}

	return result;
}


// Parse an IPv6 string to a BigInt (0 .. 2^128-1) or null. Handles `::` expansion
// and a trailing IPv4 tail (e.g. `::ffff:1.2.3.4`).
function ipv6ToBig(s) {

	let result = null;

	if (s.indexOf(':') > -1) {

		let str = s;

		// A trailing IPv4 (last group written in dotted form) → two hex groups.
		const lastColon = str.lastIndexOf(':');
		const tail = str.slice(lastColon + 1);

		if (tail.indexOf('.') > -1) {

			const v4 = ipv4ToBig(tail);
			if (v4 === null) { return null; }
			const hi = (v4 >> 16n) & 0xffffn;
			const lo = v4 & 0xffffn;
			str = str.slice(0, lastColon + 1) + hi.toString(16) + ':' + lo.toString(16);
		}

		const halves = str.split('::');

		if (halves.length <= 2) {

			const head = halves[0] ? halves[0].split(':') : [];
			const back = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : null;

			let groups;

			if (back === null) {

				groups = head;                       // no '::' — must be exactly 8 groups
			}
			else {

				const missing = 8 - (head.length + back.length);
				if (missing < 1) { return null; }    // '::' must stand for >= 1 zero group
				groups = head.concat(Array(missing).fill('0')).concat(back);
			}

			if (groups.length === 8) {

				let ok = true;
				let n = 0n;

				for (const g of groups) {

					if (!/^[0-9a-f]{1,4}$/.test(g)) { ok = false; break; }
					n = (n << 16n) + BigInt(parseInt(g, 16));
				}

				if (ok) { result = n; }
			}
		}
	}

	return result;
}


// Parse an address (either family) → { version, big } or null.
function parseIp(ip) {

	let result = null;

	const s = normalizeIp(ip);

	if (s) {

		if (s.indexOf(':') > -1) {

			const big = ipv6ToBig(s);
			if (big !== null) { result = { version: 6, big: big }; }
		}
		else {

			const big = ipv4ToBig(s);
			if (big !== null) { result = { version: 4, big: big }; }
		}
	}

	return result;
}


// Parse a CIDR rule ("10.0.0.0/8") → { version, network, prefix, bits } or null.
function parseCidr(rule) {

	let result = null;

	if (typeof rule === 'string' && rule.indexOf('/') > -1) {

		const [ base, lenStr ] = rule.trim().split('/');
		const ip = parseIp(base);

		if (ip && /^\d{1,3}$/.test(lenStr)) {

			const prefix = Number(lenStr);
			const bits = ip.version === 4 ? 32 : 128;

			if (prefix >= 0 && prefix <= bits) {

				result = { version: ip.version, network: ip.big, prefix: prefix, bits: bits };
			}
		}
	}

	return result;
}


// Convert a friendly IPv4 wildcard / partial ("192.168.1.*", "192.168.", "10.*") to a CIDR
// string. Returns null if it is not a valid partial. Only leading concrete octets are allowed
// (a concrete octet after a wildcard, e.g. "10.*.5", is rejected). Four concrete octets is just
// an exact address and is returned unchanged.
function v4PartialToCidr(rule) {

	let result = null;

	let s = rule.trim().toLowerCase();
	if (s.endsWith('.')) { s = s.slice(0, -1); }

	const octets = s.split('.');

	if (octets.length >= 1 && octets.length <= 4) {

		const concrete = [];
		let seenWild = false;
		let ok = true;

		for (const o of octets) {

			if (o === '*' || o === '') { seenWild = true; continue; }
			if (seenWild) { ok = false; break; }                 // concrete octet after a wildcard
			if (!/^\d{1,3}$/.test(o) || Number(o) > 255) { ok = false; break; }
			concrete.push(o);
		}

		if (ok && concrete.length >= 1) {

			if (concrete.length === 4) {

				result = concrete.join('.');                     // fully specified → exact address
			}
			else {

				const network = concrete.concat(Array(4 - concrete.length).fill('0')).join('.');
				result = network + '/' + (concrete.length * 8);  // e.g. 192.168.1.* → 192.168.1.0/24
			}
		}
	}

	return result;
}


// Expand any accepted rule form to a canonical rule string (an exact IP or a CIDR), or null if
// invalid. Accepts: exact IPv4/IPv6, CIDR for either family, and IPv4 wildcard/partial notation.
function expandRule(rule) {

	let result = null;

	if (typeof rule === 'string' && rule.trim() !== '') {

		const r = rule.trim().toLowerCase();

		if (r.indexOf('/') > -1) {

			result = parseCidr(r) ? r : null;                    // CIDR (v4 or v6)
		}
		else if (r.indexOf(':') === -1 && (r.indexOf('*') > -1 || r.endsWith('.') || r.split('.').length < 4)) {

			result = v4PartialToCidr(r);                         // IPv4 wildcard / partial
		}
		else {

			result = parseIp(r) ? r : null;                      // exact IPv4 / IPv6
		}
	}

	return result;
}


// True if a single rule (exact IP, CIDR, or IPv4 wildcard/partial) matches the address.
function matchOne(ip, rule) {

	let ok = false;

	const addr = parseIp(ip);
	const canonical = expandRule(rule);

	if (addr && canonical) {

		if (canonical.indexOf('/') > -1) {

			const cidr = parseCidr(canonical);

			if (cidr && cidr.version === addr.version) {

				const shift = BigInt(cidr.bits - cidr.prefix);
				// prefix 0 → mask everything off (matches all), avoid shifting by full width.
				ok = (cidr.prefix === 0) ? true : ((addr.big >> shift) === (cidr.network >> shift));
			}
		}
		else {

			const other = parseIp(canonical);
			ok = !!other && other.version === addr.version && other.big === addr.big;
		}
	}

	return ok;
}


// True if the address matches ANY rule in the list.
function matchesAny(ip, list) {

	return Array.isArray(list) && list.some(function (rule) { return matchOne(ip, rule); });
}


// Loopback (127.0.0.0/8 or ::1) — always exempt at the server-wide / login layers.
function isLoopback(ip) {

	return matchOne(ip, '127.0.0.0/8') || matchOne(ip, '::1');
}


// Decide whether an address is allowed given { allow, deny } lists.
//   - a deny match always wins (returns not-allowed)
//   - an empty allow list means "allow all" (still subject to deny)
//   - opts.allowLoopback (default false) short-circuits loopback to allowed — used by the
//     server-wide and login layers so local/console access can never be locked out.
// Accepts allow/deny under either { allow, deny } or { allowlist, blocklist } keys.
function evaluate(ip, rules, opts) {

	rules = rules || {};
	opts = opts || {};

	const allow = rules.allow || rules.allowlist || [];
	const deny = rules.deny || rules.blocklist || [];

	let result = { allowed: true, reason: 'ok' };

	if (opts.allowLoopback && isLoopback(ip)) {

		result = { allowed: true, reason: 'loopback' };
	}
	else if (deny.length && matchesAny(ip, deny)) {

		result = { allowed: false, reason: 'blocklisted' };
	}
	else if (allow.length && !matchesAny(ip, allow)) {

		result = { allowed: false, reason: 'not in allowlist' };
	}

	return result;
}


// Validate a single rule string for the UI (accepts exact IP, CIDR, or IPv4 wildcard/partial).
// Returns { valid, error, canonical } — canonical is the expanded form (handy for previews).
function validateRule(rule) {

	let out = { valid: false, error: 'empty', canonical: null };

	if (typeof rule === 'string' && rule.trim() !== '') {

		const canonical = expandRule(rule);

		if (canonical) {

			out = { valid: true, error: null, canonical: canonical };
		}
		else {

			const looksCidr = rule.indexOf('/') > -1;
			out = { valid: false, error: looksCidr ? 'invalid CIDR range' : 'invalid IP address or subnet', canonical: null };
		}
	}

	return out;
}


// Filter a raw list of rule strings to the valid ones (for storing UI input safely).
function sanitizeList(list) {

	const out = [];

	if (Array.isArray(list)) {

		for (const r of list) {

			if (typeof r === 'string' && r.trim() !== '' && validateRule(r).valid) { out.push(r.trim().toLowerCase()); }
		}
	}

	return out;
}


module.exports = {
	normalizeIp,
	parseIp,
	parseCidr,
	expandRule,
	matchOne,
	matchesAny,
	isLoopback,
	evaluate,
	validateRule,
	sanitizeList
};