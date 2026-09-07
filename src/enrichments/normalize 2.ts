/**
 * Input normalisation for cache keys.
 *
 * The point is that "https://www.Acme.com/careers" and "acme.com" are one
 * lookup, not two — see DESIGN.md section 4.3 on idempotency. Every adapter's
 * cacheKey runs its inputs through here.
 */

/** Lowercase, strip protocol, www., port, path, query and trailing slash. */
export function normalizeDomain(value: string | null | undefined): string {
  if (!value) return "";
  return value
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .replace(/^www\./, "")
    .replace(/[/?#].*$/, "")
    .replace(/:\d+$/, "")
    .replace(/\.$/, "");
}

/**
 * Lowercase the origin, keep the path (it is meaningful in a URL), and drop a
 * trailing slash so ".../in/jane/" and ".../in/jane" agree.
 */
export function normalizeUrl(value: string | null | undefined): string {
  if (!value) return "";
  const trimmed = value.trim();
  if (!trimmed) return "";

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  try {
    const url = new URL(withScheme);
    const host = url.host.toLowerCase().replace(/^www\./, "");
    const path = url.pathname.replace(/\/+$/, "");
    return `${url.protocol.toLowerCase()}//${host}${path}${url.search}`;
  } catch {
    // Not parseable as a URL — fall back to a plain lowercase trim so the key
    // stays stable rather than throwing inside cacheKey.
    return trimmed.toLowerCase().replace(/\/+$/, "");
  }
}

/** Lowercase and trim. The local part is case-sensitive in theory and never in practice. */
export function normalizeEmail(value: string | null | undefined): string {
  if (!value) return "";
  return value.trim().toLowerCase();
}
