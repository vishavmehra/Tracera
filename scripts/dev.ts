// Starts the API and the worker as separate processes in Node watch mode.
import { spawn } from "node:child_process";

const children = ["main-api", "main-worker"].map((entry) =>
	spawn(
		process.execPath,
		["--env-file-if-exists=.env", "--watch", `apps/server/src/${entry}.ts`],
		{
			stdio: "inherit",
		},
	),
);

const stopAll = () => {
	for (const child of children)
		if (child.exitCode === null) child.kill("SIGINT");
};

process.on("SIGINT", stopAll);
process.on("SIGTERM", stopAll);
for (const child of children) {
	child.on("exit", (code) => {
		stopAll();
		process.exitCode = code ?? 0;
	});
}
