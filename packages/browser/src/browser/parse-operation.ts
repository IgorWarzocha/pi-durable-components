import {
	isRecordValue,
	line,
	offset,
	optionalString,
	requiredRef,
	requiredString,
	responseLength,
} from "./operation-input.ts";
import { parseTabOperation } from "./parse-tab-operation.ts";

export { isRecordValue } from "./operation-input.ts";

import {
	BROWSER_ACTIONS,
	type BrowserAction,
	type BrowserOperation,
} from "./operation.ts";

export type ActionRequest = BrowserOperation | { action: "help" };

const fields = (...names: string[]) => new Set(["action", ...names]);

const ACTION_FIELDS: Record<BrowserAction, ReadonlySet<string>> = {
	help: fields(),
	start: fields(),
	tabs: fields("query", "offset", "owned_only"),
	open: fields("ref_id", "url", "lineno", "response_length"),
	show: fields("ref_id"),
	close: fields("ref_id"),
	find: fields("ref_id", "pattern", "lineno", "response_length"),
	click: fields("ref_id", "id", "selector", "x", "y"),
	type: fields("ref_id", "id", "text"),
	fill: fields("ref_id", "id", "selector", "value"),
	press: fields("ref_id", "key"),
	wait: fields("ref_id", "selector", "text", "url_includes", "timeout_ms"),
	screenshot: fields("ref_id", "id", "selector"),
	html: fields("ref_id", "id", "selector"),
	navigate: fields("ref_id", "url"),
	evaluate: fields("ref_id", "expression"),
	network: fields("ref_id"),
	load_all: fields("ref_id", "selector", "interval_ms"),
	raw: fields("ref_id", "method", "params"),
	read_result: fields("handle", "offset"),
	discard_result: fields("handle"),
	stop: fields("ref_id"),
};

function resultHandle(value: unknown): string {
	const handle = requiredString(value, "handle");
	if (!/^[a-f0-9-]{36}$/.test(handle)) {
		throw new Error("handle is invalid");
	}
	return handle;
}

function browserAction(value: unknown): BrowserAction {
	if (
		typeof value !== "string" ||
		!BROWSER_ACTIONS.includes(value as BrowserAction)
	) {
		throw new Error(`action must be one of: ${BROWSER_ACTIONS.join(", ")}`);
	}
	return value as BrowserAction;
}

export function parseActionRequest(value: unknown): ActionRequest {
	if (!isRecordValue(value)) throw new Error("input must be a JSON object");
	const action = browserAction(value["action"]);
	const unknown = Object.keys(value).filter(
		(key) => !ACTION_FIELDS[action].has(key),
	);
	if (unknown.length > 0) {
		throw new Error(`unknown ${action} field(s): ${unknown.join(", ")}`);
	}
	if (action === "help" || action === "start") return { action };
	if (action === "tabs") {
		const query = optionalString(value["query"], "query");
		const ownedOnly = value["owned_only"];
		if (ownedOnly !== undefined && typeof ownedOnly !== "boolean")
			throw new Error("owned_only must be a boolean");
		return {
			action,
			...(query ? { query } : {}),
			offset: offset(value["offset"]),
			...(ownedOnly === undefined ? {} : { owned_only: ownedOnly }),
		};
	}
	if (action === "open") {
		const refId = optionalString(value["ref_id"], "ref_id");
		const url = optionalString(value["url"], "url");
		if (Boolean(refId) === Boolean(url)) {
			throw new Error("open requires exactly one of ref_id or url");
		}
		if (url) return { action, url };
		if (!refId) throw new Error("open requires ref_id or url");
		return {
			action,
			ref_id: refId,
			lineno: line(value["lineno"]),
			response_length: responseLength(value["response_length"]),
		};
	}
	if (action === "find") {
		return {
			action,
			ref_id: requiredRef(value["ref_id"], action),
			pattern: requiredString(value["pattern"], "pattern"),
			lineno: line(value["lineno"]),
			response_length: responseLength(value["response_length"]),
		};
	}
	if (action === "read_result") {
		return {
			action,
			handle: resultHandle(value["handle"]),
			offset: offset(value["offset"]),
		};
	}
	if (action === "discard_result") {
		return { action, handle: resultHandle(value["handle"]) };
	}
	if (action === "stop") {
		const refId = optionalString(value["ref_id"], "ref_id");
		return { action, ...(refId ? { ref_id: refId } : {}) };
	}

	return parseTabOperation(action, requiredRef(value["ref_id"], action), value);
}
