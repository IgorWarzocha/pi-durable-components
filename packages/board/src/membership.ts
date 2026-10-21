import { randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import type {
	ConversationId,
	ConversationRecord,
	Cursor,
	ToolExecutionApi,
	Tx,
} from "@earendil-works/pi-durable";
import { AgentDoc, defineDoc, LiveDoc } from "@earendil-works/pi-durable";
import type { BoardParams } from "./contract.ts";
import { BoardFamilies } from "./family-policy.ts";

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
	checkpointWhen: (_value, _ops, { deltasSinceBase }) => deltasSinceBase >= 64,
	initial: () => ({ members: {}, ownerFolders: {} }),
});

export async function boardAddresses(tx: Tx, conversationId: ConversationId) {
	const member = (await tx.doc(BoardMembers)).members[String(conversationId)];
	const addresses: Record<string, string> =
		member === undefined ? {} : { [member.boardId]: member.agentName };
	for (const [boardId, family] of Object.entries(
		(await tx.doc(BoardFamilies)).families,
	)) {
		const name = family.participants[String(conversationId)];
		if (name !== undefined) addresses[boardId] = name;
	}
	return addresses;
}
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
	checkpointWhen: (_value, _ops, { deltasSinceBase }) => deltasSinceBase >= 64,
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

/** Native ownership is independent of history forks. Saved explicit bindings win. */
async function membership(tx: Tx, caller: ConversationId) {
	const records = new Map<ConversationId, ConversationRecord>();
	let cursor: Cursor | undefined;
	do {
		const page = await tx.scanConversations({}, 100, cursor);
		for (const record of page.items) records.set(record.id, record);
		cursor = page.next;
	} while (cursor !== undefined);
	const directory = await tx.doc(BoardMembers);
	const visiting = new Set<ConversationId>();
	async function ensure(id: ConversationId): Promise<Member> {
		const present = directory.members[String(id)];
		if (present !== undefined) return present;
		if (visiting.has(id)) throw new Error("Cyclic conversation ownership");
		visiting.add(id);
		const record = records.get(id);
		if (record === undefined) throw new Error(`No conversation ${id}`);
		const owner = record.owner?.conversationId;
		const value =
			owner === undefined ? root(id) : child(await ensure(owner), owner, id);
		directory.members[String(id)] = value;
		visiting.delete(id);
		return value;
	}
	for (const record of records.values()) await ensure(record.id);
	await ensure(caller);
	return directory;
}

export async function boardScope(
	tx: Tx,
	caller: ConversationId,
	ownerFolder: string,
	boardId?: string,
) {
	const directory = await membership(tx, caller);
	let member = directory.members[String(caller)];
	if (member === undefined) throw new Error("Missing board membership");
	const policies = await tx.doc(BoardFamilies);
	if (boardId !== undefined && boardId !== member.boardId) {
		const family = policies.families[boardId];
		const agentName = family?.participants[String(caller)];
		if (family === undefined || agentName === undefined)
			throw new Error("No write participation granted for this board");
		member = {
			boardId,
			rootConversationId: family.anchorConversationId,
			agentName,
		};
	}
	if (!Object.hasOwn(directory.ownerFolders, member.boardId)) {
		const rootAgent = await tx.doc(AgentDoc, member.rootConversationId);
		directory.ownerFolders[member.boardId] =
			member.rootConversationId === caller && ownerFolder !== ""
				? ownerFolder
				: (rootAgent.cwd ?? "");
	}
	const members: Record<string, ConversationId> = {};
	for (const [id, value] of Object.entries(directory.members)) {
		if (value.boardId === member.boardId)
			members[value.agentName] = Number(id) as ConversationId;
	}
	const family = policies.families[member.boardId];
	for (const [id, agentName] of Object.entries(family?.participants ?? {}))
		members[agentName] = Number(id) as ConversationId;
	return {
		boardId: member.boardId,
		rootConversationId: member.rootConversationId,
		agentName: member.agentName,
		callerConversationId: caller,
		ownerFolder: directory.ownerFolders[member.boardId] ?? "",
		members,
		canManageThreads:
			family === undefined
				? member.rootConversationId === caller
				: family.residentConversationId === caller,
	};
}

export async function changeMembership(
	args: BoardParams,
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
		const numeric = Number(args.target);
		if (
			args.target === undefined ||
			!/^\d+$/.test(args.target) ||
			!Number.isSafeInteger(numeric) ||
			numeric < 0
		)
			throw new Error("target must be a native conversation ID");
		const target = numeric as ConversationId;
		if ((await tx.conversation(target)) === undefined)
			throw new Error(`No conversation ${target}`);
		if (target === api.conversationId)
			throw new Error("Cannot change your own board membership");
		const directory = await membership(tx, api.conversationId);
		const caller = directory.members[String(api.conversationId)];
		const current = directory.members[String(target)];
		if (caller === undefined || current === undefined)
			throw new Error("Missing board membership");
		const family = (await tx.doc(BoardFamilies)).families[current.boardId];
		if (family?.residentConversationId === target)
			throw new Error(
				"The host must release resident authority before moving this conversation",
			);
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
	return {
		[args.action === "attach" ? "attached" : "detached"]: true,
		target: String(result.target),
		board_id: result.boardId,
		boardAgent: result.agentName,
	};
}
