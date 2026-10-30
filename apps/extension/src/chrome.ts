/**
 * The part of the Chrome extension API that Tracera uses, typed here instead of adding @types/chrome.
 * Code reaches it through `chromeApi()`, so tests can install a fake on `globalThis.chrome`.
 */
export type StorageArea = {
	get(keys: string | string[]): Promise<Record<string, unknown>>;
	set(items: Record<string, unknown>): Promise<void>;
	remove(keys: string | string[]): Promise<void>;
	/** Missing in older Chrome releases and possibly limited to `session`, so callers feature-detect and catch. */
	setAccessLevel?(options: { accessLevel: "TRUSTED_CONTEXTS" }): Promise<void>;
};

export type Tab = {
	id?: number;
	windowId: number;
	url?: string;
	title?: string;
	active?: boolean;
};

export type MessageSender = {
	id?: string;
	url?: string;
	tab?: Tab;
	frameId?: number;
};

export type InjectionResult<T> = { frameId: number; result?: T };

export type ChromeApi = {
	runtime: {
		id: string;
		getURL(path: string): string;
		sendMessage(message: unknown): Promise<unknown>;
		onMessage: {
			addListener(
				listener: (
					message: unknown,
					sender: MessageSender,
					sendResponse: (response: unknown) => void,
				) => boolean | undefined,
			): void;
		};
		onInstalled: { addListener(listener: () => void): void };
		onStartup: { addListener(listener: () => void): void };
	};
	tabs: {
		query(info: { active: true; currentWindow: true }): Promise<Tab[]>;
		get(tabId: number): Promise<Tab>;
		create(properties: { url: string }): Promise<Tab>;
		captureVisibleTab(
			windowId: number,
			options: { format: "png" },
		): Promise<string>;
		onUpdated: {
			addListener(
				listener: (tabId: number, change: { status?: string }) => void,
			): void;
		};
	};
	scripting: {
		executeScript<Args extends unknown[], Result>(injection: {
			target: { tabId: number };
			world?: "ISOLATED" | "MAIN";
			func: (...args: Args) => Result;
			args?: Args;
		}): Promise<InjectionResult<Awaited<Result>>[]>;
	};
	storage: { local: StorageArea; session: StorageArea };
	action: {
		setBadgeText(details: { tabId: number; text: string }): Promise<void>;
		setBadgeBackgroundColor(details: {
			tabId: number;
			color: string;
		}): Promise<void>;
	};
};

export const chromeApi = (): ChromeApi =>
	(globalThis as unknown as { chrome: ChromeApi }).chrome;
