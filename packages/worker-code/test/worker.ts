import wasmModule from "@jitl/quickjs-wasmfile-release-sync/wasm";
import { admissionWorkflow } from "./admission.ts";
import {
	cancellationWorkflow,
	durableWorkflow,
	runtimeWorkflow,
} from "./workflows.ts";

// Local workerd fixture only. This endpoint is not part of the published package.
export default {
	async fetch(request: Request) {
		try {
			const path = new URL(request.url).pathname;
			return Response.json(
				path === "/runtime"
					? await runtimeWorkflow(wasmModule)
					: path === "/cancel" || path === "/terminate"
						? await cancellationWorkflow(wasmModule, path === "/terminate")
						: path === "/admission"
							? await admissionWorkflow(wasmModule)
							: await durableWorkflow(wasmModule),
			);
		} catch (error) {
			return Response.json(
				{ error: error instanceof Error ? error.message : String(error) },
				{ status: 500 },
			);
		}
	},
};
