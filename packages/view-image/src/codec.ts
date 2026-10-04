import { createHash } from "node:crypto";
import { Transformer } from "@napi-rs/image";
import sharp from "sharp";

export type ViewImageContent = {
	type: "image";
	data: string;
	mimeType: string;
};

const CACHE_ENTRIES = 32;
const CACHE_BYTES = 64 * 1024 * 1024;

/** The Original path validates every pixel but never rotates or rewrites passthrough formats. */
export function createImageCodec() {
	const cache = new Map<string, { image: ViewImageContent; size: number }>();
	let cacheBytes = 0;

	return async (
		bytes: Uint8Array,
		path: string,
		signal?: AbortSignal,
	): Promise<ViewImageContent> => {
		signal?.throwIfAborted();
		const digest = createHash("sha1").update(bytes).digest("hex");
		const cached = cache.get(digest);
		if (cached) {
			cache.delete(digest);
			cache.set(digest, cached);
			return { ...cached.image };
		}

		const input = Buffer.from(bytes);
		// Reject the native dependencies' extra formats: the source build enables only these four.
		const format = detectFormat(input);
		if (!format)
			throw new Error(
				`unable to process image at \`${path}\`: unsupported image format`,
			);
		let encoded: Buffer;
		try {
			if (format === "gif") {
				encoded = await decodeGif(input, signal);
			} else {
				// Unlike sharp metadata(), this calls image::load_from_memory_with_format,
				// fully decoding pixels with the source's Rust image decoder family.
				await new Transformer(input).metadata(false, signal);
				encoded = input;
			}
			signal?.throwIfAborted();
		} catch (cause) {
			signal?.throwIfAborted();
			throw new Error(
				`unable to process image at \`${path}\`: failed to decode image: ${cause instanceof Error ? cause.message : String(cause)}`,
				{ cause },
			);
		}

		const image: ViewImageContent = {
			type: "image",
			data: encoded.toString("base64"),
			mimeType: format === "gif" ? "image/png" : `image/${format}`,
		};
		if (encoded.byteLength <= CACHE_BYTES) {
			// Parallel calls can finish decoding the same digest before either caches it.
			const previous = cache.get(digest);
			if (previous) cacheBytes -= previous.size;
			cache.delete(digest);
			cache.set(digest, { image: { ...image }, size: encoded.byteLength });
			cacheBytes += encoded.byteLength;
			while (cache.size > CACHE_ENTRIES || cacheBytes > CACHE_BYTES) {
				const oldest = cache.entries().next().value;
				if (!oldest) break;
				cache.delete(oldest[0]);
				cacheBytes -= oldest[1].size;
			}
		}
		return image;
	};
}

async function decodeGif(input: Buffer, signal?: AbortSignal): Promise<Buffer> {
	// @napi-rs/image does not compile a GIF decoder. Decode only the first frame with sharp.
	const decoder = sharp(input, {
		animated: false,
		failOn: "error",
		limitInputPixels: false,
	});
	const abort = () => {
		decoder.destroy();
	};
	signal?.addEventListener("abort", abort, { once: true });
	try {
		const { data, info } = await decoder
			.ensureAlpha()
			.raw()
			.toBuffer({ resolveWithObject: true });
		signal?.throwIfAborted();
		return await sharp(data, {
			raw: { width: info.width, height: info.height, channels: info.channels },
		})
			.png()
			.toBuffer();
	} finally {
		signal?.removeEventListener("abort", abort);
		decoder.destroy();
	}
}

function detectFormat(
	bytes: Buffer,
): "png" | "jpeg" | "gif" | "webp" | undefined {
	if (
		bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
	)
		return "png";
	if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
		return "jpeg";
	if (["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii")))
		return "gif";
	if (
		bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
		bytes.subarray(8, 12).toString("ascii") === "WEBP"
	)
		return "webp";
	return undefined;
}
