import assert from "node:assert/strict";
import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import sharp from "sharp";
import { createImageCodec } from "../src/codec.ts";

const binary = process.env["VIEW_IMAGE_REFERENCE_BINARY"];

test("Original codec agrees with pinned Rust helper on passthrough, orientation, first GIF frame and invalid inputs", {
	skip:
		!binary &&
		"Set VIEW_IMAGE_REFERENCE_BINARY to run the read-only differential probe",
}, async () => {
	assert.ok(binary);
	const directory = await mkdtemp(join(tmpdir(), "view-image-parity-"));
	try {
		const load = createImageCodec();
		const create = {
			width: 7,
			height: 3,
			channels: 4 as const,
			background: "red",
		};
		const fixtures = {
			png: await sharp({ create })
				.withMetadata({ orientation: 6 })
				.png()
				.toBuffer(),
			jpeg: await sharp({ create })
				.withMetadata({ orientation: 6 })
				.jpeg()
				.toBuffer(),
			webp: await sharp({ create })
				.withMetadata({ orientation: 6 })
				.webp()
				.toBuffer(),
			gif: await sharp(
				Buffer.from([
					255, 0, 0, 255, 0, 255, 0, 0, 0, 0, 255, 255, 255, 255, 0, 255,
				]),
				{ raw: { width: 2, height: 2, pageHeight: 1, channels: 4 } },
			)
				.gif()
				.toBuffer(),
			large: await sharp({ create: { ...create, width: 2200 } })
				.png()
				.toBuffer(),
		};
		for (const [format, bytes] of Object.entries(fixtures)) {
			const path = join(directory, format);
			await writeFile(path, bytes);
			const rust: SpawnSyncReturns<string> = spawnSync(
				binary,
				[JSON.stringify({ path })],
				{ encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
			);
			assert.equal(rust.status, 0, rust.stderr);
			const parsed: unknown = JSON.parse(rust.stdout);
			assert.ok(
				parsed &&
					typeof parsed === "object" &&
					"image_url" in parsed &&
					typeof parsed.image_url === "string",
			);
			const image = await load(bytes, path);
			assert.equal("detail" in parsed ? parsed.detail : undefined, "original");
			if (format === "gif") {
				const expected = Buffer.from(parsed.image_url.split(",")[1]!, "base64");
				const actual = Buffer.from(image.data, "base64");
				const expectedPixels = await sharp(expected)
					.ensureAlpha()
					.raw()
					.toBuffer({ resolveWithObject: true });
				const actualPixels = await sharp(actual)
					.ensureAlpha()
					.raw()
					.toBuffer({ resolveWithObject: true });
				assert.deepEqual(actualPixels.info, expectedPixels.info);
				// RGB values underneath a transparent pixel are not rendering semantics.
				for (let index = 0; index < actualPixels.data.length; index += 4) {
					assert.equal(
						actualPixels.data[index + 3],
						expectedPixels.data[index + 3],
					);
					if (actualPixels.data[index + 3])
						assert.deepEqual(
							actualPixels.data.subarray(index, index + 4),
							expectedPixels.data.subarray(index, index + 4),
						);
				}
				assert.equal(image.mimeType, "image/png");
			} else {
				assert.equal(
					`data:${image.mimeType};base64,${image.data}`,
					parsed.image_url,
				);
				assert.deepEqual(Buffer.from(image.data, "base64"), bytes);
			}
		}
		const rejected = [
			Buffer.from("plain text"),
			Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
			Buffer.from("BM unsupported BMP"),
			fixtures.png.subarray(0, Math.floor(fixtures.png.length / 2)),
		];
		for (const [index, bytes] of rejected.entries()) {
			const path = join(directory, `invalid-${index}`);
			await writeFile(path, bytes);
			const rust: SpawnSyncReturns<string> = spawnSync(
				binary,
				[JSON.stringify({ path })],
				{ encoding: "utf8" },
			);
			assert.notEqual(rust.status, 0, "Rust should reject fixture");
			await assert.rejects(load(bytes, path));
		}
		// Decoder tolerances are observable too. These inputs exposed libvips parity gaps.
		const barePng = await sharp({ create }).png().toBuffer();
		const bareJpeg = await sharp({ create }).jpeg().toBuffer();
		const bareWebp = await sharp({ create }).webp().toBuffer();
		const edgeCases = [
			{
				name: "incomplete-png-iend",
				bytes: barePng.subarray(0, barePng.length - 10),
				accepted: false,
			},
			{
				name: "jpeg-missing-final-d9",
				bytes: bareJpeg.subarray(0, bareJpeg.length - 1),
				accepted: true,
			},
			{
				name: "webp-missing-final-padding",
				bytes: bareWebp.subarray(0, bareWebp.length - 1),
				accepted: true,
			},
		];
		for (const fixture of edgeCases) {
			const path = join(directory, fixture.name);
			await writeFile(path, fixture.bytes);
			const rust: SpawnSyncReturns<string> = spawnSync(
				binary,
				[JSON.stringify({ path })],
				{ encoding: "utf8" },
			);
			assert.equal(
				rust.status === 0,
				fixture.accepted,
				`reference acceptance: ${fixture.name}`,
			);
			if (fixture.accepted) {
				const image = await load(fixture.bytes, path);
				assert.deepEqual(
					Buffer.from(image.data, "base64"),
					fixture.bytes,
					fixture.name,
				);
			} else {
				await assert.rejects(
					load(fixture.bytes, path),
					/unable to process image/,
					fixture.name,
				);
			}
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
