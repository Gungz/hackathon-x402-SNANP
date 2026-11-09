/**
 * Allowlist helper for verification evidence domains.
 */

const ALLOWED_DOMAINS = (process.env.ALLOWED_DOMAINS || "bbc.com,espn.com,reuters.com,apnews.com")
  .split(",")
  .map((d) => d.trim().toLowerCase())
  .filter(Boolean);

/**
 * Check whether a hostname is on the allowlist.
 */
export function isDomainAllowed(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return ALLOWED_DOMAINS.some((d) => h === d || h.endsWith(`.${d}`));
}

/**
 * Check whether a URL's domain is on the allowlist.
 */
export function isUrlAllowed(url: string): boolean {
  try {
    return isDomainAllowed(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * Extract and validate the hostname from a URL.
 */
export function extractHostname(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export { ALLOWED_DOMAINS };
