import type { ToolControl } from "@earendil-works/pi-durable";

/** Built-in round policy: union additions, any termination, first handoff in call order. */
export function combineControls(
	controls: readonly (ToolControl | undefined)[],
): ToolControl | undefined {
	const addTools = [
		...new Set(controls.flatMap((control) => control?.addTools ?? [])),
	];
	const terminate = controls.some((control) => control?.terminate === true);
	const handoff = controls.find(
		(control) => control?.handoff !== undefined,
	)?.handoff;
	if (addTools.length === 0 && !terminate && handoff === undefined)
		return undefined;
	return {
		...(addTools.length === 0 ? {} : { addTools }),
		...(terminate ? { terminate: true as const } : {}),
		...(handoff === undefined ? {} : { handoff }),
	};
}
