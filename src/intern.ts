/**
 * Structural interning, applied while a source document is parsed.
 *
 * bifrost-parameters publishes a `model_parameters` UI schema per model, and
 * 9,934 models share 532 distinct ones: 14.61 MB of object-valued fields, 0.99
 * MB of distinct content. Parsed naively that is a separate object graph per
 * model, and with the other three sources alongside it the build wants more than
 * the 128 MB a Worker isolate has.
 *
 * So equal values become ONE value. A reviver runs bottom-up, so an inner
 * descriptor is already interned by the time its array is considered, and each
 * duplicate is dropped the instant it is built -- the collector reclaims it
 * during the parse rather than after it. Depth: docs/memory.md.
 *
 * What this is allowed to assume: a parsed source value is READ-ONLY from here
 * on. merge.ts copies references and never writes through one, and the fields
 * this service owns (`aliases`, `pricing`, `sources`) are objects it creates
 * itself. Mutating an interned value would change it for every model sharing it.
 *
 * What it does NOT change: the bytes served. Two models holding one array
 * serialize exactly as two models holding equal arrays.
 */

/**
 * The largest value worth interning, in serialized bytes.
 *
 * This is a MEMORY bound, not a tuning knob. Deciding two values are equal costs
 * one serialization of each, and the winner's text is then held for the rest of
 * the build. Above this size that text costs about what the duplicate it saves
 * would have, and the top-level document -- 18 MB, unique by construction --
 * would be serialized in full for a comparison that can never match.
 */
const MAX_INTERNED_BYTES = 64 * 1024;

export class Interner {
	private readonly held = new Map<string, object>();
	/**
	 * Serialized size of every value this has interned. It is how a container is
	 * weighed without serializing it: the reviver is bottom-up, so each child is
	 * already measured or already known to be over the bound.
	 */
	private readonly weight = new WeakMap<object, number>();

	/** Distinct values held. Reported by /health, so the saving is checkable. */
	get size(): number {
		return this.held.size;
	}

	/**
	 * parse is JSON.parse with every object and array folded onto its first equal
	 * sibling. A primitive is passed straight through: V8 already shares short
	 * strings, and weighing a number costs more than the number.
	 */
	parse(text: string): unknown {
		return JSON.parse(text, (_key, value) => {
			if (value === null || typeof value !== "object") return value;
			const size = this.weigh(value as object);
			if (size < 0) return value;
			// Key order is the document's own, preserved by JSON.parse, so two
			// records written in different orders intern separately. That is a
			// missed saving, never a wrong answer.
			const canonical = JSON.stringify(value);
			if (canonical.length > MAX_INTERNED_BYTES) return value;
			const first = this.held.get(canonical);
			if (first !== undefined) return first;
			this.held.set(canonical, value as object);
			this.weight.set(value as object, canonical.length);
			return value;
		});
	}

	/**
	 * weigh returns a value's serialized size from its children's, or -1 when it
	 * is over the bound. A child object with no recorded weight was itself over
	 * the bound, so its parent is too.
	 */
	private weigh(value: object): number {
		let total = 2; // the brackets
		for (const child of Object.values(value)) {
			total += 2; // a separator, and a key's quotes or an array's nothing
			if (child === null || typeof child !== "object") {
				total += typeof child === "string" ? child.length + 2 : 8;
			} else {
				const known = this.weight.get(child);
				if (known === undefined) return -1;
				total += known;
			}
			if (total > MAX_INTERNED_BYTES) return -1;
		}
		if (!Array.isArray(value)) {
			for (const key of Object.keys(value)) total += key.length + 1;
		}
		return total > MAX_INTERNED_BYTES ? -1 : total;
	}
}
