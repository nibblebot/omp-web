/** Validate a provider authorization URL before navigating a trusted browser popup.
 * Authorization codes are delivered only to the daemon callback; credentials
 * must never travel through a browser-manager DTO.
 */
export function validateOAuthLaunchUrl(value: unknown) {
	if (typeof value !== "string") throw new Error("OAuth did not return an authorization URL");
	const url = new URL(value);
	if (
		url.protocol !== "https:" ||
		url.username ||
		url.password ||
		[...url.searchParams.keys()].some((key) =>
			/^(access_token|refresh_token|id_token|client_secret)$/i.test(key),
		)
	) {
		throw new Error("Unsafe OAuth authorization URL refused");
	}
	return url.href;
}
