import { randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import type {
	ConversationId,
	ToolExecutionApi,
	Tx,
} from "@earendil-works/pi-durable";
import { AgentDoc, defineDoc, LiveDoc } from "@earendil-works/pi-durable";
import type { Request } from "../contract.ts";
import { response } from "../contract.ts";
import { Fleet, resolveTarget } from "../state.ts";

type Binding = {
	boardId: string;
	rootConversationId: ConversationId;
	agentName: string;
};
type Member = Binding & { parent?: ConversationId; previous?: Binding };
export const BoardMembers = defineDoc<{
	members: Record<string, Member>;
	ownerFolders: Record<string, string>;
}>({
	kind: "howaboua.agents.board.members",
	version: 1,
	scope: "session",
	initial: () => ({ members: {}, ownerFolders: {} }),
});
const MembershipReceipt = defineDoc<{
	saved: {
		request: string;
		target: ConversationId;
		boardId: string;
		agentName: string;
	} | null;
}>({
	kind: "howaboua.agents.board.membership-change",
	version: 1,
	scope: "task",
	initial: () => ({ saved: null }),
});

function root(id: ConversationId): Member {
	return { boardId: randomUUID(), rootConversationId: id, agentName: "/root" };
}
function child(
	parent: Member,
	parentId: ConversationId,
	id: ConversationId,
): Member {
	return {
		boardId: parent.boardId,
		rootConversationId: parent.rootConversationId,
		agentName: `${parent.agentName}/agent-${id}`,
		parent: parentId,
	};
}

/** Backfill pre-board workers from their durable controller links, never from forked history. */
export async function membership(tx: Tx, caller: ConversationId) {
	const directory = await tx.doc(BoardMembers);
	const fleet = await tx.doc(Fleet);
	const visiting = new Set<ConversationId>();
	function ensure(id: ConversationId): Member {
		const present = directory.members[String(id)];
		if (present !== undefined) return present;
		if (visiting.has(id)) throw new Error("Cyclic agent controller membership");
		visiting.add(id);
		const agent = fleet.agents[String(id)];
		const value =
			agent === undefined
				? root(id)
				: child(ensure(agent.controller), agent.controller, id);
		directory.members[String(id)] = value;
		visiting.delete(id);
		return value;
	}
	for (const agent of Object.values(fleet.agents)) ensure(agent.target);
	ensure(caller);
	return directory;
}

/** Call before task creation, then add the new child to this already-loaded directory. */
export function registerBoardChild(
	directory: { members: Record<string, Member> },
	parentId: ConversationId,
	id: ConversationId,
): string {
	const parent = directory.members[String(parentId)];
	if (parent === undefined)
		throw new Error("Missing controller board membership");
	const member = child(parent, parentId, id);
	directory.members[String(id)] = member;
	return member.agentName;
}

export async function boardScope(
	tx: Tx,
	caller: ConversationId,
	ownerFolder: string,
) {
	const directory = await membership(tx, caller);
	const member = directory.members[String(caller)];
	if (member === undefined) throw new Error("Missing board membership");
	if (!Object.hasOwn(directory.ownerFolders, member.boardId)) {
		const rootAgent = await tx.doc(AgentDoc, member.rootConversationId);
		directory.ownerFolders[member.boardId] =
			member.rootConversationId === caller
				? ownerFolder
				: (rootAgent.cwd ?? "");
	}
	const members: Record<string, ConversationId> = {};
	for (const [id, value] of Object.entries(directory.members)) {
		if (value.boardId === member.boardId)
			members[value.agentName] = Number(id) as ConversationId;
	}
	return {
		boardId: member.boardId,
		rootConversationId: member.rootConversationId,
		agentName: member.agentName,
		callerConversationId: caller,
		ownerFolder: directory.ownerFolders[member.boardId] ?? "",
		members,
	};
}

export async function changeMembership(
	args: Extract<Request, { action: "attach" | "detach" }>,
	api: ToolExecutionApi,
	context: Context,
) {
	const result = await api.commit(async (tx) => {
		const receipt = await tx.doc(MembershipReceipt, api.taskId);
		const request = JSON.stringify(args);
		if (receipt.saved !== null) {
			if (receipt.saved.request !== request)
				throw new Error("Membership task replay arguments changed");
			return { ...receipt.saved };
		}
		const target = await resolveTarget(tx, args.target);
		if (target === api.conversationId)
			throw new Error("Cannot change your own board membership");
		const directory = await membership(tx, api.conversationId);
		// Host-created peers need not have called the board before.
		directory.members[String(target)] ??= root(target);
		const caller = directory.members[String(api.conversationId)];
		const current = directory.members[String(target)];
		if (caller === undefined || current === undefined)
			throw new Error("Missing board membership");
		const live = await tx.doc(LiveDoc, target);
		if (live.run !== undefined)
			throw new Error(
				"Board membership can change only while the target is idle",
			);
		if (Object.values(directory.members).some((item) => item.parent === target))
			throw new Error("Cannot move an agent with board children");
		let next: Member;
		if (args.action === "attach") {
			if (current.parent !== undefined || current.boardId === caller.boardId)
				throw new Error(
					"Target already belongs to an agent tree; detach it first",
				);
			next = {
				...child(caller, api.conversationId, target),
				// Never resurrect subscriptions to an earlier attachment address.
				agentName: `${caller.agentName}/agent-${target}-${randomUUID()}`,
				previous: {
					boardId: current.boardId,
					rootConversationId: current.rootConversationId,
					agentName: current.agentName,
				},
			};
		} else {
			if (
				current.boardId !== caller.boardId ||
				!current.agentName.startsWith(`${caller.agentName}/`)
			)
				throw new Error("Can detach only your own board descendants");
			next =
				current.previous === undefined ? root(target) : { ...current.previous };
		}
		directory.members[String(target)] = next;
		const saved = {
			request,
			target,
			boardId: next.boardId,
			agentName: next.agentName,
		};
		receipt.saved = saved;
		return saved;
	}, context);
	return response({
		[args.action === "attach" ? "attached" : "detached"]: true,
		target: String(result.target),
		board_id: result.boardId,
		boardAgent: result.agentName,
	});
}
