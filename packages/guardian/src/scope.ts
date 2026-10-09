import { spawn } from "node:child_process";
import { isRecord } from "./review.ts";

export type Rule = {
	tool: string;
	args: Record<string, string>;
	action: "review" | "block";
};
export function parseRules(value: unknown): Rule[] {
	if (
		!isRecord(value) ||
		Object.keys(value).some((key) => key !== "rules") ||
		!Array.isArray(value["rules"]) ||
		value["rules"].length > 256 ||
		Buffer.byteLength(JSON.stringify(value)) > 65536
	)
		throw new Error("Invalid Guardian rules");
	return value["rules"].map((rule) => {
		if (
			!isRecord(rule) ||
			Object.keys(rule).some(
				(key) => !["tool", "args", "action"].includes(key),
			) ||
			typeof rule["tool"] !== "string" ||
			!rule["tool"] ||
			!["review", "block"].includes(String(rule["action"])) ||
			(rule["args"] !== undefined && !isRecord(rule["args"]))
		)
			throw new Error("Invalid Guardian rule");
		const args: Record<string, string> = Object.create(null);
		for (const [key, pattern] of Object.entries(rule["args"] ?? {})) {
			if (typeof pattern !== "string" || pattern.length > 4096)
				throw new Error("Invalid Guardian regex");
			new RegExp(pattern);
			args[key] = pattern;
		}
		return {
			tool: rule["tool"],
			args,
			action: rule["action"] as Rule["action"],
		};
	});
}

// Configured regexes can backtrack catastrophically on model-controlled strings.
// Node owns regex evaluation even when Pi runs on Bun, whose workers lack heap limits.
// A disposable process bounds CPU and isolates memory from the host.
const MATCH_PROCESS = `
const rules = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
let decision = "pass";
for (const rule of rules) {
	if (!rule.args.every(([pattern, value]) => new RegExp(pattern).test(value))) continue;
	if (rule.action === "block") { decision = "block"; break; }
	decision = "review";
}
process.stdout.write(decision);
`;

export type Decision = "pass" | "review" | "block";
export function decideAction(
	tool: string,
	input: unknown,
	rules: Rule[],
	signal: AbortSignal,
	nativeRegex: boolean,
): Decision | Promise<Decision> {
	const candidates: { action: Rule["action"]; args: [string, string][] }[] = [];
	let totalBytes = 0;
	for (const rule of rules) {
		if (rule.tool !== tool) continue;
		const predicates: [string, string][] = [];
		let matches = true;
		for (const [key, pattern] of Object.entries(rule.args)) {
			const value =
				isRecord(input) && Object.hasOwn(input, key) ? input[key] : undefined;
			if (typeof value !== "string") {
				matches = false;
				break;
			}
			predicates.push([pattern, value]);
		}
		if (!matches) continue;
		if (rule.action === "block" && !predicates.length) return "block";
		for (const [, value] of predicates)
			totalBytes += Buffer.byteLength(value, "utf8");
		candidates.push({ action: rule.action, args: predicates });
	}
	if (!candidates.length) return "pass";
	if (totalBytes > 1024 * 1024)
		throw new Error("Argument matching exceeds 1 MiB");
	if (candidates.every((rule) => !rule.args.length)) return "review";
	if (!nativeRegex) throw new Error("Native regex capability required");
	signal.throwIfAborted();
	return new Promise<Decision>((resolve, reject) => {
		const child = spawn(
			process.versions["bun"] ? "node" : process.execPath,
			["--max-old-space-size=32", "--stack-size=1024", "-e", MATCH_PROCESS],
			{
				stdio: ["pipe", "pipe", "ignore"],
				env: { ...process.env, NODE_OPTIONS: "" },
			},
		);
		let failure: Error | undefined;
		let output = "";
		const stop = (error: Error) => {
			failure ??= error;
			child.kill("SIGKILL");
		};
		const abort = () => stop(new Error("Argument matching cancelled"));
		const timer = setTimeout(
			() => stop(new Error("Argument matching timed out")),
			1000,
		);
		signal.addEventListener("abort", abort, { once: true });
		child.stdout.on("data", (chunk: Buffer) => {
			output += chunk.toString("utf8");
			if (output.length > 16) stop(new Error("Argument matching failed"));
		});
		child.once("error", () =>
			stop(new Error("Node argument matcher unavailable")),
		);
		child.stdin.once("error", () =>
			stop(new Error("Argument matching failed")),
		);
		child.once("close", (code) => {
			clearTimeout(timer);
			signal.removeEventListener("abort", abort);
			if (failure) reject(failure);
			else if (
				code === 0 &&
				(output === "pass" || output === "review" || output === "block")
			)
				resolve(output);
			else reject(new Error("Argument matching failed"));
		});
		child.stdin.end(JSON.stringify(candidates));
		if (signal.aborted) abort();
	});
}
