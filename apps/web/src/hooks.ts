import { useQuery } from "@tanstack/react-query";
import { getSession } from "./api.ts";

/** The signed-in session; shares its cache entry with the shell's session check. */
export const useSession = () =>
	useQuery({
		queryKey: ["session"],
		queryFn: getSession,
		staleTime: 5 * 60_000,
	});

/** Owner-only actions (repository registration) are offered only to owners; the API enforces it. */
export const useIsOwner = () => useSession().data?.workspace.role === "owner";

/** While work is queued or running; workers report progress every 1.5–2 s. */
export const POLL_MS = 2000;
