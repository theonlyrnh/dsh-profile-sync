#!/usr/bin/env node
/**
 * dsh-profile-sync CLI: manual push/pull/status against the sync repository.
 *
 * Usage:
 *   dsh-profile-sync push        push local config to the remote
 *   dsh-profile-sync pull        pull remote config (backup local first, install plugins)
 *   dsh-profile-sync status      show sync posture
 *   --home <path>             override the DSH home (defaults to $DSH_HOME or ~/.dsh)
 *
 * Installed into the profile's node_modules, the binary is not on PATH by
 * default; call it through the profile:
 *   pnpm --dir "$DSH_HOME/profiles/web" exec dsh-profile-sync push
 * @module dsh-profile-sync/cli
 */
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { dshHome, pullSync, pushSync, readSyncConfig, readToken, statusSync, SyncError } from "./core.js";

const USAGE = `Usage:
  dsh-profile-sync push [--home <path>]
  dsh-profile-sync pull [--home <path>]
  dsh-profile-sync status [--home <path>]`;

const defaultIo = {
	out: (line) => process.stdout.write(`${line}\n`),
	err: (line) => process.stderr.write(`${line}\n`)
};

// stdout piped into head/less closes early: exit quietly instead of crashing.
for (const stream of [process.stdout, process.stderr]) stream.on("error", (error) => {
	if (error?.code === "EPIPE") process.exit(0);
});

function valueOf(argv, flag) {
	const at = argv.indexOf(flag);
	if (at === -1) return undefined;
	const value = argv[at + 1];
	if (value === undefined || value.startsWith("--")) throw new SyncError(`${flag} requires a value`, "USAGE");
	return value;
}

function errorMessage(error) {
	if (error instanceof SyncError) return error.message;
	if (error instanceof Error) return error.message;
	return String(error);
}

/** Return the process exit code. All IO is injected for testability. */
export async function main(argv, io) {
	const action = argv[0];
	if (action !== "push" && action !== "pull" && action !== "status") {
		io.err(USAGE);
		return 1;
	}
	let home;
	try {
		home = dshHome(valueOf(argv, "--home"));
	} catch (error) {
		io.err(errorMessage(error));
		io.err(USAGE);
		return 1;
	}
	const log = (line) => io.out(`  ${line}`);
	const token = readToken(home, readSyncConfig(home).credentialRef);
	try {
		if (action === "push") {
			io.out("dsh-profile-sync: pushing local configuration...");
			const result = await pushSync({ home, token, log });
			if (result.pushed) io.out(`dsh-profile-sync: pushed ${result.staged.length} changed files`);
			else io.out("dsh-profile-sync: nothing to push (already in sync)");
		} else if (action === "pull") {
			io.out("dsh-profile-sync: pulling remote configuration...");
			const result = await pullSync({ home, token, log });
			if (result.written.length === 0) io.out("dsh-profile-sync: nothing new to apply");
			else io.out(`dsh-profile-sync: applied ${result.written.length} files`);
			for (const backup of result.backups) io.out(`  backed up: ${backup}`);
			for (const warning of result.warnings) io.out(`  warning: ${warning}`);
			for (const profile of result.installed) io.out(`  installed plugins: ${profile}`);
			io.out("dsh-profile-sync: if dsh web is running, restart it to apply host-side changes");
		} else {
			const report = await statusSync({ home, token });
			io.out(`configured:   ${String(report.configured)}`);
			if (report.configured) {
				io.out(`remote:       ${report.remote}`);
				io.out(`branch:       ${report.branch}`);
				io.out(`auth:         ${report.authMode === "token" ? `token (${report.tokenPresent ? "present" : "missing"})` : report.authMode === "ssh" ? "ssh (public key)" : report.authMode}`);
			}
			io.out(`repo:         ${report.repoExists ? "cloned" : "not cloned yet"}`);
			io.out(`dsh version:  ${report.dshVersion}`);
			if (report.lastCommit !== undefined) io.out(`last commit:  ${new Date(report.lastCommit.committedAt).toISOString()} ${report.lastCommit.message}`);
			for (const file of report.files) io.out(`  ${file.state.padEnd(14)} ${file.rel}`);
		}
		return 0;
	} catch (error) {
		io.err(`dsh-profile-sync: ${errorMessage(error)}`);
		return 1;
	}
}

// Entry guard must compare real paths: pnpm-installed node_modules bins are
// symlinked, so argv[1] is the link while import.meta.url is the real file.
const entryPath = process.argv[1] ? realpathSync(process.argv[1]) : "";
if (import.meta.url === pathToFileURL(entryPath).href) {
	void main(process.argv.slice(2), defaultIo).then((code) => {
		process.exitCode = code;
	});
}
