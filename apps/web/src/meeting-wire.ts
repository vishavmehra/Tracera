import {
	type ConfirmMeetingCandidateRequest,
	type ImportMeetingRequest,
	type MeetingCandidate,
	MeetingCandidateKindSchema,
	type MeetingProvider,
	SeveritySchema,
	TRANSCRIPT_CONTENT_TYPES,
	type UpdateMeetingCandidateRequest,
	type UploadMeetingTranscriptRequest,
} from "@tracera/contracts";

// What the Meetings pages put on the wire, and how they read the redirect that ends the Google
// sign-in. Kept free of React so the server tests can run these exact functions against the real API.

// ---- Request bodies -----------------------------------------------------------------------------

/** The type the server accepts with a transcript: the browser's own when it is on the list, else empty. */
export const declaredTranscriptType = (browserType: string) => {
	const type = browserType.toLowerCase();
	return (TRANSCRIPT_CONTENT_TYPES as readonly string[]).includes(type)
		? type
		: "";
};

export const uploadBody = (input: {
	filename: string;
	browserType: string;
	dataBase64: string;
	title: string;
	provider: MeetingProvider;
	repositoryId: string;
}): UploadMeetingTranscriptRequest => ({
	provider: input.provider,
	consent_attested: true,
	...(input.title ? { title: input.title } : {}),
	...(input.repositoryId ? { repository_id: input.repositoryId } : {}),
	transcript: {
		filename: input.filename,
		content_type: declaredTranscriptType(input.browserType),
		data_base64: input.dataBase64,
	},
});

export const importBody = (input: {
	ref: string;
	title: string | undefined;
	repositoryId: string;
}): ImportMeetingRequest => ({
	provider_meeting_ref: input.ref,
	consent_attested: true,
	...(input.title ? { title: input.title } : {}),
	...(input.repositoryId ? { repository_id: input.repositoryId } : {}),
});

export const confirmBody = (input: {
	repositoryKnown: boolean;
	repositoryId: string;
	duplicate: boolean;
}): ConfirmMeetingCandidateRequest => ({
	// Filing the report and starting an investigation are separate actions.
	start_investigation: false,
	...(!input.repositoryKnown && input.repositoryId
		? { repository_id: input.repositoryId }
		: {}),
	...(input.duplicate ? { acknowledge_duplicate: true } : {}),
});

/** Only what a reviewer changed. `text` returns a trimmed form value, or "" when the field is empty. */
export function candidatePatch(
	candidate: MeetingCandidate,
	text: (name: string) => string,
): UpdateMeetingCandidateRequest {
	const patch: UpdateMeetingCandidateRequest = {};
	const kind = MeetingCandidateKindSchema.safeParse(text("kind"));
	if (kind.success && kind.data !== candidate.kind) patch.kind = kind.data;
	const severity = SeveritySchema.safeParse(text("severity"));
	if (severity.success && severity.data !== candidate.severity)
		patch.severity = severity.data;
	if (text("title") && text("title") !== candidate.title)
		patch.title = text("title");
	if (text("description") && text("description") !== candidate.description)
		patch.description = text("description");
	if (text("expected") !== (candidate.expected_behavior ?? ""))
		patch.expected_behavior = text("expected") || null;
	if (text("actual") !== (candidate.actual_behavior ?? ""))
		patch.actual_behavior = text("actual") || null;
	const steps = text("steps")
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	if (steps.join("\n") !== candidate.steps.join("\n")) patch.steps = steps;
	if (text("repository_id") !== (candidate.repository_id ?? ""))
		patch.repository_id = text("repository_id") || null;
	return patch;
}

// ---- The result of the Google sign-in -----------------------------------------------------------

export type CallbackOutcome = {
	tone: "done" | "warn" | "bad";
	title: string;
	detail: string;
};

const NOT_STORED = "Nothing was connected";

/**
 * Every result the server's callback redirects with (`?integration=google&result=<code>`): its own
 * outcomes, and the code of the provider error when the exchange with Google failed.
 */
export const CALLBACK_OUTCOMES: Readonly<Record<string, CallbackOutcome>> = {
	connected: {
		tone: "done",
		title: "Google Meet connection completed",
		detail:
			"Tracera stored the connection. The Google Meet card shows its current status.",
	},
	denied: {
		tone: "warn",
		title: "Google access was not granted",
		detail: `The Google sign-in was cancelled or access was declined. ${NOT_STORED}.`,
	},
	invalid_state: {
		tone: "bad",
		title: "The connection attempt could not be matched to your session",
		detail: `The sign-in link may have expired, or it was started in another browser or session. ${NOT_STORED}. Connect again.`,
	},
	scope_not_granted: {
		tone: "warn",
		title: "Transcript access was not granted",
		detail:
			"Google signed you in without the permission to read meeting transcripts, so Tracera did not change the connection. Connect again and allow that permission.",
	},
	failed: {
		tone: "bad",
		title: "Google did not complete the connection",
		detail: `Google returned an error or no authorization code. ${NOT_STORED}; try again.`,
	},
	provider_token_expired: {
		tone: "bad",
		title: "Google refused the authorization",
		detail: `The authorization may have expired or been revoked, or this server's Google client settings may be wrong. ${NOT_STORED}. Connect again; if it keeps failing, ask whoever runs this server to check the Google client settings.`,
	},
	provider_permission_denied: {
		tone: "bad",
		title: "Google refused access for this account",
		detail: `The account needs a Google Workspace edition with Meet transcripts, and an administrator may block this app. ${NOT_STORED}.`,
	},
	provider_unavailable: {
		tone: "bad",
		title: "Google could not be reached",
		detail: `Tracera could not finish the exchange with Google. ${NOT_STORED}; try again later.`,
	},
	provider_request_failed: {
		tone: "bad",
		title: "Google rejected the connection request",
		detail: `That can mean this server's Google client ID, secret, or redirect address is wrong. ${NOT_STORED}; ask whoever runs this server to check them.`,
	},
	provider_response_invalid: {
		tone: "bad",
		title: "Google answered in an unexpected way",
		detail: `Tracera could not read Google's answer. ${NOT_STORED}; try again later.`,
	},
	provider_artifact_unavailable: {
		tone: "bad",
		title: "Google could not complete the connection",
		detail: `Google said it did not find what it was asked for. ${NOT_STORED}; try again later.`,
	},
};

const UNKNOWN_OUTCOME: CallbackOutcome = {
	tone: "bad",
	title: "Google Meet could not be connected",
	detail: `The connection did not complete. ${NOT_STORED}.`,
};

/**
 * The message for a `result` value from the address bar. The value is only a key: an unknown one gets
 * the generic message and none of its text is shown.
 */
export const callbackOutcome = (result: string): CallbackOutcome =>
	Object.hasOwn(CALLBACK_OUTCOMES, result)
		? (CALLBACK_OUTCOMES[result] as CallbackOutcome)
		: UNKNOWN_OUTCOME;
