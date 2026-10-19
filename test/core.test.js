import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pnpmCommands, pullSync, pushSync, readSyncConfig, readToken, writeSyncConfig } from "../lib/core.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "dsh-profile-sync-"));

function seedProfile(home, profile = "desktop") {
	const dir = path.join(home, "profiles", profile);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: profile, dsh: { profile: { bundles: ["@deepseek-ai/dsh-base"] } }, dependencies: {} }));
	fs.writeFileSync(path.join(dir, "cordis.patch.yml"), "[]\n");
	fs.writeFileSync(path.join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
	fs.writeFileSync(path.join(home, "settings.yaml"), "llm-pi-ai: {}\n");
}

test("own config round-trips and is 0600", () => {
	const home = tmp();
	writeSyncConfig(home, { remote: "https://example.com/r.git", branch: "main" });
	const config = readSyncConfig(home);
	assert.equal(config.remote, "https://example.com/r.git");
	assert.equal(config.branch, "main");
	const file = path.join(home, "sync-state", "config.yaml");
	assert.ok(fs.existsSync(file));
	assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test("migrates the legacy settings.yaml section once", () => {
	const home = tmp();
	seedProfile(home);
	fs.writeFileSync(path.join(home, "settings.yaml"),
		"dsh-profile-sync:\n  remote: https://example.com/legacy.git\n  branch: main\n  autoInstallPlugins: false\n");
	const config = readSyncConfig(home);
	assert.equal(config.remote, "https://example.com/legacy.git");
	assert.ok(fs.existsSync(path.join(home, "sync-state", "config.yaml")));
	// the legacy file is left untouched; the own file is the source now
	fs.writeFileSync(path.join(home, "settings.yaml"), "llm-pi-ai: {}\n");
	assert.equal(readSyncConfig(home).remote, "https://example.com/legacy.git");
});

test("token precedence: env, then own config", () => {
	const home = tmp();
	writeSyncConfig(home, { remote: "https://example.com/r.git", token: "from-config" });
	assert.equal(readToken(home, "DSH_SYNC_TOKEN"), "from-config");
	process.env.DSH_SYNC_TOKEN = "from-env";
	try {
		assert.equal(readToken(home, "DSH_SYNC_TOKEN"), "from-env");
	} finally {
		delete process.env.DSH_SYNC_TOKEN;
	}
});

test("push then pull against a local bare remote", async () => {
	const remote = tmp();
	execFileSync("git", ["init", "--bare", remote]);

	const a = tmp();
	seedProfile(a);
	writeSyncConfig(a, { remote, branch: "main", autoInstallPlugins: false });
	await pushSync({ home: a });

	const b = tmp();
	seedProfile(b);
	fs.writeFileSync(path.join(b, "profiles", "desktop", "package.json"),
		JSON.stringify({ name: "desktop", dsh: { profile: { bundles: [] } }, dependencies: {} }));
	writeSyncConfig(b, { remote, branch: "main", autoInstallPlugins: false });
	await pullSync({ home: b });

	assert.deepEqual(
		JSON.parse(fs.readFileSync(path.join(b, "profiles", "desktop", "package.json"), "utf8")),
		JSON.parse(fs.readFileSync(path.join(a, "profiles", "desktop", "package.json"), "utf8")));
	const backups = fs.readdirSync(path.join(b, "profiles", "desktop")).filter((f) => f.includes(".local-backup-"));
	assert.ok(backups.length > 0, "pull must back the overwritten file up");
});

test("push works without settings.yaml and keeps the remote copy", async () => {
	const remote = tmp();
	execFileSync("git", ["init", "--bare", remote]);
	const home = tmp();
	seedProfile(home);
	fs.writeFileSync(path.join(home, "settings.yaml"), "theme: dark\n");
	writeSyncConfig(home, { remote, branch: "main", autoInstallPlugins: false });
	await pushSync({ home });
	fs.rmSync(path.join(home, "settings.yaml"));
	await pushSync({ home });
	const repo = path.join(home, "sync-state", "repo");
	assert.ok(fs.existsSync(path.join(repo, "settings.yaml")), "the remote copy must not be deleted");
});

test("pnpmCommands includes the PATH entry and the bundled runtime copy", () => {
	const commands = pnpmCommands();
	assert.ok(commands.length >= 1);
	assert.ok(commands.some(([command]) => command.endsWith("pnpm") || command.endsWith("pnpm.cmd") || command.endsWith("node") || command.endsWith("node.exe")));
});

test("pull installs plugins (or warns) without failing the pull", async () => {
	const remote = tmp();
	execFileSync("git", ["init", "--bare", remote]);
	const a = tmp();
	seedProfile(a);
	writeSyncConfig(a, { remote, branch: "main", autoInstallPlugins: false });
	await pushSync({ home: a });

	const b = tmp();
	seedProfile(b);
	fs.writeFileSync(path.join(b, "profiles", "desktop", "package.json"),
		JSON.stringify({ name: "desktop", dsh: { profile: { bundles: [] } }, dependencies: {} }));
	writeSyncConfig(b, { remote, branch: "main", autoInstallPlugins: true });
	const result = await pullSync({ home: b });
	assert.ok(result.installed.includes("desktop") || result.warnings.some((w) => w.includes("插件安装失败")));
});
