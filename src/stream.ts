import type { Model } from "./types.ts";

/**
 * jsonListStream writes the answer model by model.
 *
 * One JSON.stringify of the whole catalogue allocates a 22 MB string on top of
 * the 12k objects that produced it, and a Worker isolate is capped at 128 MB.
 * Encoding one model at a time keeps the largest live string at one model's
 * worth, and lets Cloudflare start sending before the tail is encoded.
 *
 * The envelope is written by hand for the same reason, and the ORDER is part of
 * the contract: `object` and `data` come first so a client streaming the
 * response sees OpenAI's shape immediately, and `modelinfo` -- which is only
 * complete once every model has been counted -- comes last.
 */
export function jsonListStream(
	models: Model[],
	trailer: (returned: number) => unknown,
): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	let at = 0;

	return new ReadableStream({
		start(controller) {
			controller.enqueue(encoder.encode('{"object":"list","data":['));
		},
		pull(controller) {
			if (at >= models.length) {
				controller.enqueue(
					encoder.encode(`],"modelinfo":${JSON.stringify(trailer(models.length))}}`),
				);
				controller.close();
				return;
			}
			// A chunk rather than a single model: one enqueue per model over 12k
			// models is 12k round trips through the stream machinery for no gain.
			const end = Math.min(at + 100, models.length);
			let chunk = "";
			for (let i = at; i < end; i++) {
				if (i > 0) chunk += ",";
				chunk += JSON.stringify(models[i]);
			}
			at = end;
			controller.enqueue(encoder.encode(chunk));
		},
	});
}
