/**
 * HTTP content coding shared by the static UI server and the control plane's
 * JSON answers.
 */

/** Codings the request accepts (q=0 refuses), from its Accept-Encoding header. */
export function acceptedCodings(header: string | null): Set<string> {
	const accepted = new Set<string>();
	if (header === null) return accepted;
	for (const part of header.split(",")) {
		const [rawCoding, ...params] = part.trim().toLowerCase().split(";");
		const coding = rawCoding?.trim();
		const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
		if (coding && !(q !== undefined && Number(q.slice(2)) === 0)) accepted.add(coding);
	}
	return accepted;
}

/** JSON answers under this size ride uncompressed: the saving is below one packet. */
export const COMPRESS_JSON_MIN_BYTES = 1024;

/**
 * gzip a JSON answer when the client accepts it and the body is large enough
 * (the settings model is 173 KB, 37 KB gzipped). Only `application/json`
 * is touched: downloads, event streams and NDJSON keep streaming as they are,
 * and an answer that already carries a content-encoding passes through.
 * Compressing at level 6 costs a few ms for the largest answers.
 */
export async function compressJson(req: Request, res: Response): Promise<Response> {
	if (
		req.method === "HEAD" ||
		res.body === null ||
		res.status < 200 ||
		res.status === 204 ||
		res.status === 304 ||
		res.headers.has("content-encoding") ||
		!(res.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")
	) {
		return res;
	}
	const headers = new Headers(res.headers);
	headers.append("vary", "Accept-Encoding");
	const body = await res.arrayBuffer();
	if (
		body.byteLength < COMPRESS_JSON_MIN_BYTES ||
		!acceptedCodings(req.headers.get("accept-encoding")).has("gzip")
	) {
		return new Response(body, { status: res.status, statusText: res.statusText, headers });
	}
	headers.set("content-encoding", "gzip");
	headers.delete("content-length");
	return new Response(Bun.gzipSync(body, { level: 6 }), {
		status: res.status,
		statusText: res.statusText,
		headers,
	});
}
