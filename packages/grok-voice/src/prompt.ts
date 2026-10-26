export const VOICE_PROMPT = `## Role & Persona
You are a conversational assistant and the user's voice interface to a tool-equipped agent.
## Objective
- Help the user through conversation and delegated work, preserving their intent.
## Conversation Flow
- Use your available tools directly. Delegate work requiring other tools, current information or unavailable context through send_task rather than guessing.
- An accepted delegation means the agent is working, not finished. Acknowledge the handoff, then let it work until updates arrive automatically. Don't monitor, chase progress or repeat requests unless the user asks.
- During pauses, speak or use read-only tools only when useful to the current conversation. Otherwise call stay_quiet without speaking or inventing work. Later idle turns are opportunities, not demands to speak. Never announce that you are waiting or staying quiet. Base progress commentary on new agent updates.
- Handle interruptions conversationally. Respond to what the user says and continue an unfinished thought when it still matters.
- Use end_the_call when the user clearly intends to leave, after saying goodbye. When unsure, keep the call open; clarify naturally when useful without repeatedly asking.
## Guardrails & Escalation
- Preserve the user's intent, constraints and approval requirements when delegating. Don't invent additional work, facts, progress or completion.
## Voice & Communication Style
- Speak naturally and concisely without losing substance.`;

const SEND_TASK_TOOL = {
	type: "function",
	name: "send_task",
	description: "Delegate the user's request to the tool-equipped agent",
	parameters: {
		type: "object",
		properties: {
			request: {
				type: "string",
				description: "Task with all constraints and approval requirements",
			},
		},
		required: ["request"],
		additionalProperties: false,
	},
};

const END_CALL_TOOL = {
	type: "function",
	name: "end_the_call",
	description:
		"End the call after the caller clearly parts and you have said goodbye aloud",
	parameters: {
		type: "object",
		properties: {},
		additionalProperties: false,
	},
};

const STAY_QUIET_TOOL = {
	type: "function",
	name: "stay_quiet",
	description:
		"End this turn without speech when there is nothing useful to add. Keep the call open.",
	parameters: {
		type: "object",
		properties: {},
		additionalProperties: false,
	},
};

export const VOICE_TOOLS = [SEND_TASK_TOOL, END_CALL_TOOL, STAY_QUIET_TOOL];

/** Source Markdown comment validation, without ambient instruction-file access. */
function instructions(source: string, label: string): string {
	let output = "";
	let cursor = 0;
	while (cursor < source.length) {
		const opening = source.indexOf("<!--", cursor);
		const strayClosing = source.indexOf("-->", cursor);
		if (strayClosing !== -1 && (opening === -1 || strayClosing < opening))
			throw new Error(`Unmatched Markdown comment close in ${label}`);
		if (opening === -1) {
			output += source.slice(cursor);
			break;
		}
		output += source.slice(cursor, opening);
		const closing = source.indexOf("-->", opening + 4);
		if (closing === -1)
			throw new Error(`Unclosed Markdown comment in ${label}`);
		cursor = closing + 3;
	}
	return output
		.replace(/\n[ \t]+\n/g, "\n\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}
export function appendVoiceInstructions(user = "", project = ""): string {
	const global = instructions(user, "Grok user instructions");
	const local = instructions(project, "Grok project instructions");
	return [
		VOICE_PROMPT,
		global && `# User instructions\n\n${global}`,
		local && `# Project level instructions\n\n${local}`,
	]
		.filter(Boolean)
		.join("\n\n");
}
