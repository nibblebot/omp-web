// Wire shapes mirror the ExtensionUIContext dialog surface
// (extensibility/extensions/types.ts: ExtensionAskDialogQuestion,
// ExtensionAskDialogResult, ExtensionUISelectItem). Redefined locally — the
// web client must not import the server package.

export type AskOption = { label: string; description?: string; preview?: string };

export type AskQuestion = {
	id: string;
	question: string;
	header?: string;
	options: AskOption[];
	multi?: boolean;
	recommended?: number;
};

export type UiRequest = { id: string; method: string; params: unknown };
