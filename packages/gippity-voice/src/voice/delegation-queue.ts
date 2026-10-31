import type { RealtimeVoiceTurn } from "./turns.ts";

/** Admission belongs to the live service. Held requests are never persisted for replay. */
export class VoiceDelegationQueue<Owner> {
	private holds = 0;
	private held: Array<{ turn: RealtimeVoiceTurn; owner: Owner }> = [];
	private readonly active = new Set<Promise<void>>();
	private readonly deliver: (
		turn: RealtimeVoiceTurn,
		owner: Owner,
	) => Promise<void>;
	private readonly failed: (error: unknown) => void;
	constructor(
		deliver: (turn: RealtimeVoiceTurn, owner: Owner) => Promise<void>,
		failed: (error: unknown) => void,
	) {
		this.deliver = deliver;
		this.failed = failed;
	}
	push(turn: RealtimeVoiceTurn, owner: Owner): void {
		if (turn.delegationId && this.holds) {
			this.held.push({ turn, owner });
			return;
		}
		const work = this.deliver(turn, owner).catch(this.failed);
		this.active.add(work);
		void work.finally(() => this.active.delete(work));
	}
	hold(): () => void {
		this.holds++;
		let live = true;
		return () => {
			if (!live) return;
			live = false;
			if (--this.holds) return;
			for (const { turn, owner } of this.held.splice(0)) this.push(turn, owner);
		};
	}
	async flushAccepted(): Promise<void> {
		await Promise.all([...this.active]);
	}
	cancelHeld(): void {
		for (const { turn } of this.held.splice(0))
			this.failed(
				new Error(
					`Voice stopped before this request was sent: ${turn.input}. Please repeat the request when voice is available.`,
				),
			);
	}
}
