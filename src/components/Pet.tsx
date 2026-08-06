import { For, Show, createEffect, createRenderEffect, createSignal, onCleanup, onMount, type Component } from "solid-js";
import { characterForProvider, drawCharacter } from "../characters";
import { ROLE_NAMES, groupModelRoles, type RoleGroup } from "../model-roles";
import { SPRITE_SIZE, type PetPose } from "../sprite";
import { state } from "../state";
import { CharacterAvatar } from "./CharacterAvatar";

const IDLE_BLINK_MS = 150;
const WORK_BLINK_MS = 150;
const WORK_FRAME_MS = 280;
const WORK_BLINK_EVERY_MS = 2400;
const HAPPY_MS = 900;
const idleBlinkDelay = () => 2500 + Math.random() * 2500;

/** Full-size animated avatar for the primary role. Self-contained so it draws on
 *  ITS mount (the roster row may mount after Pet's, when role state arrives). */
const PetMainAvatar: Component<{ pose: () => PetPose }> = props => {
	let canvas!: HTMLCanvasElement;
	onMount(() => {
		const ctx = canvas.getContext("2d")!;
		createRenderEffect(() => drawCharacter(ctx, characterForProvider(state.model?.provider), props.pose()));
	});
	return <canvas ref={el => (canvas = el)} class="pet-main-canvas" width={SPRITE_SIZE} height={SPRITE_SIZE} />;
};

/** Animated corner pet: cycles poses by streaming state, character by model provider. */
export const Pet: Component = () => {
	const [pose, setPose] = createSignal<PetPose>("idle");
	const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
	let wasStreaming = false;

	/** Full-size pet renders at 64px (see .pet canvas CSS). Secondary roles at 56px:
	 *  literal 80% (51px) reads ~half-size for compact sprites like the whale,
	 *  so nudge up while keeping a clear size hierarchy. */
	const SECONDARY_AVATAR_SIZE = 56;

	/** Roster rows in canonical order: the active model's group first (full-size,
	 *  animated pet), then the secondary groups (80% size, greyed). */
	const roster = () => {
		const groups = groupModelRoles(state.modelRoles, state.model);
		const activeKey = state.model ? `${state.model.provider}/${state.model.id}` : undefined;
		const primaryIndex = groups.findIndex(g => `${g.provider}/${g.id}` === activeKey);
		const entries = groups.map((g, i) => ({ group: g, primary: i === primaryIndex }));
		// The pet always renders the active model even when it is not a role
		// (session-only model override): keep it as the leading row.
		if (primaryIndex === -1 && state.model) {
			entries.unshift({ group: { provider: state.model.provider, id: state.model.id, roles: [] }, primary: true });
		}
		return entries;
	};

	createEffect(() => {
		if (reducedMotion) {
			setPose(state.streaming ? "work1" : "idle");
			return;
		}

		if (state.streaming) {
			wasStreaming = true;
			let workFrame: PetPose = "work1";
			let blinkTimeout: number | undefined;
			setPose(workFrame);
			const workInterval = window.setInterval(() => {
				workFrame = workFrame === "work1" ? "work2" : "work1";
				setPose(workFrame);
			}, WORK_FRAME_MS);
			const blinkInterval = window.setInterval(() => {
				setPose("work-blink");
				blinkTimeout = window.setTimeout(() => setPose(workFrame), WORK_BLINK_MS);
			}, WORK_BLINK_EVERY_MS);
			onCleanup(() => {
				window.clearInterval(workInterval);
				window.clearInterval(blinkInterval);
				window.clearTimeout(blinkTimeout);
			});
			return;
		}

		let blinkTimeout: number | undefined;
		let idleTimeout: number | undefined;
		const scheduleBlink = () => {
			idleTimeout = window.setTimeout(() => {
				setPose("blink");
				blinkTimeout = window.setTimeout(() => setPose("idle"), IDLE_BLINK_MS);
				scheduleBlink();
			}, idleBlinkDelay());
		};
		if (wasStreaming) {
			wasStreaming = false;
			setPose("happy");
			idleTimeout = window.setTimeout(() => {
				setPose("idle");
				scheduleBlink();
			}, HAPPY_MS);
		} else {
			setPose("idle");
			scheduleBlink();
		}
		onCleanup(() => {
			window.clearTimeout(blinkTimeout);
			window.clearTimeout(idleTimeout);
		});
	});

	return (
		<div class="pet" data-streaming={state.streaming} title={characterForProvider(state.model?.provider).name}>
			<div class="pet-roster">
				<For each={roster()}>
					{e => (
						<div class="pet-role" classList={{ secondary: !e.primary }}>
							<div class="pet-role-avatar">
								{e.primary ? (
									<PetMainAvatar pose={pose} />
								) : (
									<CharacterAvatar provider={e.group.provider} size={SECONDARY_AVATAR_SIZE} />
								)}
								<span class="pet-role-name">{characterForProvider(e.group.provider).name}</span>
							</div>
							<div class="pet-role-labels">
								<For each={e.group.roles}>{r => <span>{ROLE_NAMES[r] ?? r}</span>}</For>
							</div>
						</div>
					)}
				</For>
			</div>
		</div>
	);
};
