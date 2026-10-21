import type { ToolControl } from "@earendil-works/pi-durable";

/** Nested-cell policy: union additions, any successful termination, first handoff in call order. */
export function combineControls(
	controls: readonly (ToolControl | undefined)[],
	allowTermination = true,
): ToolControl | undefined {
	const addTools = [
		...new Set(controls.flatMap((control) => control?.addTools ?? [])),
	];
	const terminate =
		allowTermination && controls.some((control) => control?.terminate === true);
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
