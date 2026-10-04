interface ResizeImageOptions {
	maxWidth: number;
	maxHeight: number;
	maxBytes: number;
}

interface ResizedImage {
	data: string;
	mimeType: string;
	width: number;
	height: number;
}

/** Native, byte-only capability. No filesystem access or provider-specific image dependency. */
export async function resizeImage(
	bytes: Uint8Array,
	mimeType: string,
	options: ResizeImageOptions,
	signal?: AbortSignal,
): Promise<ResizedImage | undefined> {
	signal?.throwIfAborted();
	const { default: sharp } = await import("sharp");
	signal?.throwIfAborted();
	const input = Buffer.from(bytes);
	const decoder = sharp(input, { animated: false, limitInputPixels: false });
	const abort = () => {
		decoder.destroy();
	};
	signal?.addEventListener("abort", abort, { once: true });
	try {
		// Decode even the passthrough path, as Photon does before checking bounds.
		const { data: pixels, info } = await decoder
			.autoOrient()
			.ensureAlpha()
			.raw()
			.toBuffer({ resolveWithObject: true });
		signal?.throwIfAborted();
		let width = info.width;
		let height = info.height;
		if (
			width <= options.maxWidth &&
			height <= options.maxHeight &&
			Math.ceil(bytes.byteLength / 3) * 4 < options.maxBytes
		) {
			return { data: input.toString("base64"), mimeType, width, height };
		}
		if (width > options.maxWidth) {
			height = Math.max(1, Math.round((height * options.maxWidth) / width));
			width = options.maxWidth;
		}
		if (height > options.maxHeight) {
			width = Math.max(1, Math.round((width * options.maxHeight) / height));
			height = options.maxHeight;
		}
		// Upstream tries PNG, then JPEG at these qualities, before reducing dimensions.
		while (true) {
			for (const quality of [undefined, 80, 85, 70, 55, 40]) {
				signal?.throwIfAborted();
				const encoder = sharp(pixels, {
					raw: {
						width: info.width,
						height: info.height,
						channels: info.channels,
					},
				}).resize(width, height, { fit: "fill", kernel: "lanczos3" });
				const cancel = () => {
					encoder.destroy();
				};
				signal?.addEventListener("abort", cancel, { once: true });
				try {
					const encoded = await (quality === undefined
						? encoder.png()
						: encoder.jpeg({ quality })
					).toBuffer();
					signal?.throwIfAborted();
					const data = encoded.toString("base64");
					if (Buffer.byteLength(data, "utf8") < options.maxBytes) {
						return {
							data,
							mimeType: quality === undefined ? "image/png" : "image/jpeg",
							width,
							height,
						};
					}
				} finally {
					signal?.removeEventListener("abort", cancel);
					encoder.destroy();
				}
			}
			if (width === 1 && height === 1) return undefined;
			width = Math.max(1, Math.floor(width * 0.75));
			height = Math.max(1, Math.floor(height * 0.75));
		}
	} finally {
		signal?.removeEventListener("abort", abort);
		decoder.destroy();
	}
}
