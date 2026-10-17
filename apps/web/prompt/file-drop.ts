import { createSignal } from "solid-js";

/** Nesting depth of file drags over the window; the drop overlay shows while > 0. */
const [fileDragDepth, setFileDragDepth] = createSignal(0);
/** Files dropped anywhere on the window, waiting for the composer to take them. */
const [droppedFiles, setDroppedFiles] = createSignal<File[] | null>(null);

export { fileDragDepth, droppedFiles, setDroppedFiles };

function carriesFiles(e: DragEvent): boolean {
	return Array.from(e.dataTransfer?.types ?? []).includes("Files");
}

/**
 * Window-wide file drop target. Drops anywhere on the window are prevented
 * (the browser would otherwise open the file) and handed to the composer.
 * Non-file drags (text selections) are left alone. Returns the teardown.
 */
export function installWindowFileDrop(): () => void {
	const onEnter = (e: DragEvent) => {
		if (!carriesFiles(e)) return;
		e.preventDefault();
		setFileDragDepth((depth) => depth + 1);
	};
	const onOver = (e: DragEvent) => {
		if (!carriesFiles(e)) return;
		e.preventDefault();
		if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
	};
	const onLeave = (e: DragEvent) => {
		if (!carriesFiles(e)) return;
		setFileDragDepth((depth) => Math.max(0, depth - 1));
	};
	const onDrop = (e: DragEvent) => {
		if (!carriesFiles(e)) return;
		e.preventDefault();
		setFileDragDepth(0);
		const files = Array.from(e.dataTransfer?.files ?? []);
		if (files.length > 0) setDroppedFiles(files);
	};
	const onEnd = () => setFileDragDepth(0);
	window.addEventListener("dragenter", onEnter);
	window.addEventListener("dragover", onOver);
	window.addEventListener("dragleave", onLeave);
	window.addEventListener("drop", onDrop);
	window.addEventListener("dragend", onEnd);
	return () => {
		window.removeEventListener("dragenter", onEnter);
		window.removeEventListener("dragover", onOver);
		window.removeEventListener("dragleave", onLeave);
		window.removeEventListener("drop", onDrop);
		window.removeEventListener("dragend", onEnd);
	};
}
