// A screen recording is read in the browser: a hidden <video> and a <canvas> take a few still frames
// and only those are uploaded. The recording itself never leaves the computer. This file imports
// nothing, so it can be run as is in a page.

export const RECORDING_LIMITS = {
	maxBytes: 200 * 1024 * 1024,
	maxSeconds: 300,
	/** Frames between the first and the last. */
	innerFrames: 10,
	maxWidth: 1280,
	/** Frames closer together than this show nothing new. */
	minSpacingSeconds: 0.25,
	/** A PNG above this is sent as a JPEG instead. */
	maxFrameBytes: 4 * 1024 * 1024,
} as const;

export type RecordingProblem =
	| "unsupported"
	| "empty"
	| "too_large"
	| "too_long"
	| "unreadable"
	| "frame_too_large"
	| "aborted";

export class RecordingError extends Error {
	readonly code: RecordingProblem;
	constructor(code: RecordingProblem, message: string) {
		super(message);
		this.name = "RecordingError";
		this.code = code;
	}
}

const megabytes = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

/** Why a file cannot be used as a recording, or null. The length is checked once the file is opened. */
export function validateRecording(
	file: { type: string; size: number },
	maxBytes: number = RECORDING_LIMITS.maxBytes,
): string | null {
	if (!file.type.startsWith("video/"))
		return "Use a video file such as WebM, MP4, or MOV.";
	if (file.size === 0) return "The file is empty.";
	if (file.size > maxBytes)
		return `The recording is ${megabytes(file.size)}; the limit is ${megabytes(maxBytes)}.`;
	return null;
}

/** `m:ss.s`, the way a timestamp is written next to a frame. */
export function clockLabel(seconds: number): string {
	const tenths = Math.round(Math.max(0, seconds) * 10);
	const minutes = Math.floor(tenths / 600);
	return `${minutes}:${((tenths % 600) / 10).toFixed(1).padStart(4, "0")}`;
}

/** The seconds at which frames are taken: the first, the last, and evenly spaced ones between. */
export function keyframeTimes(durationSeconds: number): number[] {
	const { innerFrames, minSpacingSeconds } = RECORDING_LIMITS;
	if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return [0];
	// The very end of a file often has no picture yet, so the last frame is taken just before it.
	const last = Math.max(0, durationSeconds - 0.1);
	const total = Math.max(
		1,
		Math.min(innerFrames + 2, Math.floor(last / minSpacingSeconds) + 1),
	);
	if (total === 1) return [0];
	return Array.from(
		{ length: total },
		(_, i) => Math.round((i / (total - 1)) * last * 1000) / 1000,
	);
}

/** What was sent, in words: keyframes at stated times, never a watched video. */
export function describeSampling(frameSeconds: number[]): string {
	const n = frameSeconds.length;
	return `Analyzed ${n} keyframe${n === 1 ? "" : "s"} sampled at these timestamps: ${frameSeconds.map(clockLabel).join(", ")}. The video itself was not read, so what happened between frames is inferred.`;
}

export type Keyframe = {
	index: number;
	timestampMs: number;
	blob: Blob;
	mimeType: "image/png" | "image/jpeg";
};

/** A recording opened for sampling; tests stand in for the browser's video element with this. */
export type FrameSource = {
	durationSeconds: number;
	/** The picture at that time, as PNG or JPEG bytes. */
	frameAt(
		seconds: number,
		format: { type: "image/png" | "image/jpeg"; quality?: number },
	): Promise<Blob>;
	close(): void;
};
export type OpenFrameSource = (file: File) => Promise<FrameSource>;

/** The step is named so a failure can be told apart: browsers give no reason of their own. */
const unreadable = (step: string) =>
	new RecordingError(
		"unreadable",
		`The browser could not read this recording (${step}).`,
	);

function waitFor(
	video: HTMLVideoElement,
	step: string,
	events: string[],
	done: () => boolean,
	timeoutMs = 15_000,
): Promise<void> {
	return new Promise((resolve, reject) => {
		if (done()) return resolve();
		const names = [...events, "error"];
		const finish = (error?: Error) => {
			clearTimeout(timer);
			for (const name of names) video.removeEventListener(name, onEvent);
			if (error) reject(error);
			else resolve();
		};
		const onEvent = (event: Event) => {
			if (event.type === "error") finish(unreadable(`${step}: decode error`));
			else if (done()) finish();
		};
		const timer = setTimeout(
			() => finish(unreadable(`${step}: timed out`)),
			timeoutMs,
		);
		for (const name of names) video.addEventListener(name, onEvent);
	});
}

function seek(video: HTMLVideoElement, seconds: number): Promise<void> {
	return new Promise((resolve, reject) => {
		const finish = (error?: Error) => {
			clearTimeout(timer);
			video.removeEventListener("seeked", onSeeked);
			video.removeEventListener("error", onError);
			if (error) reject(error);
			else resolve();
		};
		const onSeeked = () => finish();
		const step = `seeking to ${clockLabel(seconds)}`;
		const onError = () => finish(unreadable(`${step}: decode error`));
		const timer = setTimeout(
			() => finish(unreadable(`${step}: timed out`)),
			15_000,
		);
		video.addEventListener("seeked", onSeeked);
		video.addEventListener("error", onError);
		video.currentTime = seconds;
	});
}

/** Opens a recording in a hidden video element. */
export const openVideo: OpenFrameSource = async (file) => {
	const url = URL.createObjectURL(file);
	const video = document.createElement("video");
	video.muted = true;
	video.playsInline = true;
	video.preload = "auto";
	const close = () => {
		video.removeAttribute("src");
		video.load();
		URL.revokeObjectURL(url);
	};
	try {
		video.src = url;
		await waitFor(
			video,
			"loading the file",
			["loadedmetadata"],
			() => video.readyState >= 1,
		);
		if (!Number.isFinite(video.duration)) {
			// A file without its length in the header says Infinity until the browser has seen the end.
			video.currentTime = 1e9;
			await waitFor(
				video,
				"finding the length",
				["durationchange", "timeupdate", "seeked"],
				() => Number.isFinite(video.duration),
			);
			// Let that seek finish; a second seek started on top of it can leave the video stuck.
			await waitFor(
				video,
				"finishing the length probe",
				["seeked"],
				() => !video.seeking,
			);
		}
		const duration = video.duration;
		if (!(video.videoWidth > 0 && video.videoHeight > 0))
			throw unreadable("no picture size");
		const canvas = document.createElement("canvas");
		const scale = Math.min(1, RECORDING_LIMITS.maxWidth / video.videoWidth);
		canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
		canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
		const context = canvas.getContext("2d");
		if (!context) throw unreadable("no canvas");
		const capture = async (
			seconds: number,
			format: { type: "image/png" | "image/jpeg"; quality?: number },
		) => {
			if (Math.abs(video.currentTime - seconds) > 0.001)
				await seek(video, seconds);
			await waitFor(
				video,
				`waiting for the picture at ${clockLabel(seconds)}`,
				["loadeddata", "canplay", "seeked"],
				() => video.readyState >= 2,
			);
			context.drawImage(video, 0, 0, canvas.width, canvas.height);
			return new Promise<Blob>((resolve, reject) =>
				canvas.toBlob(
					(blob) =>
						blob ? resolve(blob) : reject(unreadable("converting a frame")),
					format.type,
					format.quality,
				),
			);
		};
		return {
			durationSeconds: duration,
			async frameAt(seconds, format) {
				// One more try: a seek that never lands is the browser's most common transient failure.
				for (let attempt = 1; ; attempt++) {
					try {
						return await capture(seconds, format);
					} catch (error) {
						if (attempt >= 2 || !(error instanceof RecordingError)) throw error;
					}
				}
			},
			close,
		};
	} catch (error) {
		close();
		throw error;
	}
};

/**
 * Takes the keyframes of a recording. PNG is preferred; a frame whose PNG is too large is sent as a JPEG.
 * Rejects a recording that is longer than the limit.
 */
export async function extractKeyframes(
	file: File,
	options: {
		open?: OpenFrameSource;
		signal?: AbortSignal;
		onProgress?: (done: number, total: number) => void;
	} = {},
): Promise<{ durationMs: number; frames: Keyframe[] }> {
	const refusal = validateRecording(file);
	if (refusal)
		throw new RecordingError(
			file.size > RECORDING_LIMITS.maxBytes
				? "too_large"
				: file.size === 0
					? "empty"
					: "unsupported",
			refusal,
		);
	const source = await (options.open ?? openVideo)(file);
	try {
		if (source.durationSeconds > RECORDING_LIMITS.maxSeconds)
			throw new RecordingError(
				"too_long",
				`The recording is ${clockLabel(source.durationSeconds)} long; the limit is ${clockLabel(RECORDING_LIMITS.maxSeconds)}.`,
			);
		const times = keyframeTimes(source.durationSeconds);
		const frames: Keyframe[] = [];
		for (const [index, seconds] of times.entries()) {
			if (options.signal?.aborted)
				throw new RecordingError(
					"aborted",
					"Preparing the recording was cancelled.",
				);
			let blob = await source.frameAt(seconds, { type: "image/png" });
			let mimeType: Keyframe["mimeType"] = "image/png";
			if (blob.size > RECORDING_LIMITS.maxFrameBytes) {
				blob = await source.frameAt(seconds, {
					type: "image/jpeg",
					quality: 0.85,
				});
				mimeType = "image/jpeg";
			}
			if (blob.size > RECORDING_LIMITS.maxFrameBytes)
				throw new RecordingError(
					"frame_too_large",
					`A frame at ${clockLabel(seconds)} is ${megabytes(blob.size)} even as a JPEG.`,
				);
			frames.push({
				index,
				timestampMs: Math.round(seconds * 1000),
				blob,
				mimeType,
			});
			options.onProgress?.(index + 1, times.length);
		}
		return {
			durationMs: Math.round(
				(Number.isFinite(source.durationSeconds) ? source.durationSeconds : 0) *
					1000,
			),
			frames,
		};
	} finally {
		source.close();
	}
}
