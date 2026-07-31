import { createEffect, createRenderEffect, createSignal, onCleanup, onMount, type Component } from "solid-js";
import { drawKimi, KIMI_SPRITE_SIZE, type KimiPose } from "../kimi-sprite";
import { state } from "../state";

const IDLE_BLINK_MS = 150;
const WORK_BLINK_MS = 150;
const WORK_FRAME_MS = 280;
const WORK_BLINK_EVERY_MS = 2400;
const HAPPY_MS = 900;
const idleBlinkDelay = () => 2500 + Math.random() * 2500;

export const Kimi: Component = () => {
	let canvas!: HTMLCanvasElement;
	const [pose, setPose] = createSignal<KimiPose>("idle");
	const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
	let wasStreaming = false;

	onMount(() => {
		const ctx = canvas.getContext("2d")!;
		createRenderEffect(() => drawKimi(ctx, pose()));
	});

	createEffect(() => {
		if (reducedMotion) {
			setPose(state.streaming ? "work1" : "idle");
			return;
		}

		if (state.streaming) {
			wasStreaming = true;
			let workFrame: KimiPose = "work1";
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
		<div class="kimi-pet" data-streaming={state.streaming} title="Kimi">
			<canvas ref={el => (canvas = el)} width={KIMI_SPRITE_SIZE} height={KIMI_SPRITE_SIZE} />
			<span class="kimi-name">kimi</span>
		</div>
	);
};
