/**
 * dsh-profile-sync core: the sync engine shared by the host plugin, the CLI, and
 * tests. Pure Node — no cordis dependency — so the CLI can run outside the
 * dsh process.
 *
 * Scope (mirrors sync-plugin-design.md):
 *   - syncs `settings.yaml`, `profiles/<name>/package.json`,
 *     `profiles/<name>/cordis.patch.yml`, `profiles/<name>/pnpm-lock.yaml`
 *   - never touches `.credentials.yaml`, `sessions/`, `storages/`,
 *     `node_modules/`, `sync-state/`
 *   - sensitive keys in settings.yaml are refused before commit
 *   - pull backs local files up as `.local-backup-<timestamp>` before overwrite
 *   - pull auto-installs profile plugins when manifests change
 *   - version mismatch between devices is a warning, never a block
 * @module dsh-profile-sync/core
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import yaml from "js-yaml";
import git from "isomorphic-git";
import http from "isomorphic-git/http/node";

/** Failure class every layer reports; code discriminates, message is user copy. */
export class SyncError extends Error {
	constructor(message, code) {
		super(message);
		this.name = "SyncError";
		this.code = code;
	}
}

export const DEFAULT_CONFIG = Object.freeze({
	remote: "",
	branch: "main",
	credentialRef: "DSH_SYNC_TOKEN",
	autoInstallPlugins: true,
	sensitiveKeyPatterns: ["(password|secret|passwd|token$|private[_-]?key)"]
});

const CREDENTIAL_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PROFILE_FILES = ["package.json", "cordis.patch.yml", "pnpm-lock.yaml"];
const GITATTRIBUTES_CONTENT = "* text=auto eol=lf\n";
const AUTH_NAME = "dsh-profile-sync";
const AUTH_EMAIL = "dsh-profile-sync@localhost";

/** The DSH home: $DSH_HOME when set, else the OS home's .dsh. */
export function dshHome(override) {
	if (override !== undefined && override !== "") return path.resolve(override);
	if (process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== "") return path.resolve(process.env.DSH_HOME);
	return path.join(os.homedir(), ".dsh");
}

export function syncStateDir(home) {
	return path.join(home, "sync-state");
}

function repoDir(home) {
	return path.join(syncStateDir(home), "repo");
}

/** Per-device anonymous label for commit messages (never leaves the repo beyond the commit). */
function deviceId(home) {
	const file = path.join(syncStateDir(home), "device-id");
	try {
		const existing = fs.readFileSync(file, "utf8").trim();
		if (existing !== "") return existing;
	} catch {}
	const fresh = crypto.randomBytes(4).toString("hex");
	fs.mkdirSync(syncStateDir(home), { recursive: true });
	fs.writeFileSync(file, `${fresh}\n`);
	return fresh;
}

/** Parse settings.yaml strictly: a broken document must fail loudly, never silently fall back. */
function readSettingsDoc(home) {
	try {
		const parsed = yaml.load(fs.readFileSync(path.join(home, "settings.yaml"), "utf8"));
		return parsed === undefined || parsed === null ? {} : parsed;
	} catch (error) {
		throw new SyncError(`settings.yaml 解析失败：${error instanceof Error ? error.message : String(error)}`, "SETTINGS_NOT_YAML");
	}
}

/** Parse settings.yaml and merge the `dsh-profile-sync` section over the defaults. */
export function readSyncConfig(home) {
	const doc = readSettingsDoc(home);
	const section = typeof doc === "object" && doc !== null && typeof doc["dsh-profile-sync"] === "object" && doc["dsh-profile-sync"] !== null ? doc["dsh-profile-sync"] : {};
	const config = {
		...DEFAULT_CONFIG,
		...section
	};
	if (typeof config.remote !== "string") throw new SyncError("dsh-profile-sync.remote must be a string", "INVALID_CONFIG");
	if (typeof config.branch !== "string" || config.branch.length === 0) throw new SyncError("dsh-profile-sync.branch must be a non-empty string", "INVALID_CONFIG");
	if (typeof config.credentialRef !== "string" || !CREDENTIAL_REF_PATTERN.test(config.credentialRef)) throw new SyncError(`dsh-profile-sync.credentialRef must match ${CREDENTIAL_REF_PATTERN}`, "INVALID_CONFIG");
	if (typeof config.autoInstallPlugins !== "boolean") throw new SyncError("dsh-profile-sync.autoInstallPlugins must be a boolean", "INVALID_CONFIG");
	if (!Array.isArray(config.sensitiveKeyPatterns) || config.sensitiveKeyPatterns.some((pattern) => typeof pattern !== "string")) throw new SyncError("dsh-profile-sync.sensitiveKeyPatterns must be an array of regex strings", "INVALID_CONFIG");
	for (const pattern of config.sensitiveKeyPatterns) try {
		new RegExp(pattern, "i");
	} catch {
		throw new SyncError(`dsh-profile-sync.sensitiveKeyPatterns contains an invalid regex: ${JSON.stringify(pattern)}`, "INVALID_CONFIG");
	}
	return config;
}

/** Read one credential reference's value from .credentials.yaml (never synced). */
export function readToken(home, ref) {
	if (typeof ref !== "string" || ref === "") return undefined;
	const doc = readYamlOr(path.join(home, ".credentials.yaml"), {});
	const refs = typeof doc === "object" && doc !== null && typeof doc.refs === "object" && doc.refs !== null ? doc.refs : {};
	const value = refs[ref];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readYamlOr(file, fallback) {
	try {
		const parsed = yaml.load(fs.readFileSync(file, "utf8"));
		return parsed === undefined ? fallback : parsed;
	} catch {
		return fallback;
	}
}

/** Profile directories under the home that carry a package.json. */
export function profileDirs(home) {
	const profilesRoot = path.join(home, "profiles");
	let names = [];
	try {
		names = fs.readdirSync(profilesRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
	} catch {
		return [];
	}
	return names.filter((name) => fs.existsSync(path.join(profilesRoot, name, "package.json")));
}

/** The relative paths one side (home or repo working dir) owns. */
export function syncedRels(home) {
	const rels = ["settings.yaml"];
	for (const profile of profileDirs(home)) for (const file of PROFILE_FILES) rels.push(path.posix.join("profiles", profile, file));
	return rels;
}

/** Normalize text files to LF so Windows and Linux machines never churn the repo. */
function normalizeText(content) {
	const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	return normalized === "" || normalized.endsWith("\n") ? normalized : `${normalized}\n`;
}

/** Refuse commits whose settings.yaml carries non-empty sensitive values. */
export function assertNoSensitiveKeys(settingsText, patterns) {
	let doc;
	try {
		doc = yaml.load(settingsText);
	} catch (error) {
		throw new SyncError(`settings.yaml is not parseable YAML: ${error instanceof Error ? error.message : String(error)}`, "SETTINGS_NOT_YAML");
	}
	const offenders = [];
	const walk = (value, keyPath) => {
		if (Array.isArray(value)) {
			value.forEach((item, index) => walk(item, `${keyPath}[${index}]`));
			return;
		}
		if (typeof value !== "object" || value === null) return;
		for (const [key, child] of Object.entries(value)) {
			const childPath = keyPath === "" ? key : `${keyPath}.${key}`;
			if (child !== null && child !== undefined && child !== "") {
				const sensitive = patterns.some((pattern) => new RegExp(pattern, "i").test(key));
				if (sensitive) offenders.push(childPath);
			}
			walk(child, childPath);
		}
	};
	walk(doc, "");
	if (offenders.length > 0) throw new SyncError(`settings.yaml 的以下键命中敏感键过滤规则，拒绝提交：${offenders.join(", ")}。若确认这些值不含密钥，请调整 dsh-profile-sync.sensitiveKeyPatterns。`, "SENSITIVE_KEY_BLOCKED");
}

/** Best-effort local dsh version; "unknown" keeps the guard warn-only. */
export function localDshVersion() {
	try {
		const result = spawnSync("dsh", ["--version"], spawnOptions(5000));
		if (result.status === 0) {
			const line = (result.stdout ?? "").trim().split(/\r?\n/)[0];
			if (line !== "") return line;
		}
	} catch {}
	return "unknown";
}

function httpAuth(token) {
	// Token in BOTH positions: the username slot satisfies classic PATs
	// (username=token, password=anything), the password slot satisfies
	// fine-grained PATs (any username, password=token). Stateless and works
	// for either token type on github.com.
	return {
		onAuth: () => ({ username: token === undefined ? "" : token, password: token === undefined ? "" : token })
	};
}

/** Transport options: the http client only for http(s) remotes, bare fs otherwise. */
function transportOf(remote, token) {
	return /^https?:\/\//i.test(remote) ? { http, ...httpAuth(token) } : {};
}

/** Refresh remote-tracking refs; an empty remote (no refs yet) is not an error. */
async function fetchRemote(dir, config, token) {
	try {
		await git.fetch({
			fs,
			dir,
			url: config.remote,
			ref: config.branch,
			singleBranch: true,
			depth: 1,
			...transportOf(config.remote, token)
		});
	} catch (error) {
		const code = error?.data?.code ?? error?.code;
		const message = error instanceof Error ? error.message : String(error);
		if (code !== "NotFoundError" && !/could not find head|no such ref|unborn/i.test(message)) throw error;
	}
}

/** Clone or open the working copy of the sync repo under <home>/sync-state/repo. */
async function ensureRepo(home, config, token) {
	const dir = repoDir(home);
	fs.mkdirSync(dir, { recursive: true });
	const exists = fs.existsSync(path.join(dir, ".git"));
	if (!exists) {
		if (config.remote === "") throw new SyncError("尚未配置仓库地址：请先在设置页或 settings.yaml 的 dsh-profile-sync.remote 填入私有仓库 URL", "REMOTE_MISSING");
		try {
			await git.clone({
				fs,
				dir,
				url: config.remote,
				ref: config.branch,
				singleBranch: true,
				depth: 1,
				noTags: true,
				...transportOf(config.remote, token)
			});
		} catch (error) {
			fs.rmSync(dir, { recursive: true, force: true });
			if (error instanceof Error && /authentication|401|403/i.test(error.message)) throw new SyncError(`仓库认证失败：请检查 dsh-profile-sync.credentialRef（当前 ${config.credentialRef}）对应的 token 是否已填写且拥有该仓库读写权限`, "AUTH_FAILED");
			throw new SyncError(`无法克隆 ${config.remote}：${error instanceof Error ? error.message : String(error)}`, "CLONE_FAILED");
		}
	}
	// This workdir is owned entirely by dsh-profile-sync and tracks one branch only:
	// point HEAD at the configured branch on every open (clone of an empty
	// remote leaves HEAD on the default branch, which would never exist).
	const headFile = path.join(dir, ".git", "HEAD");
	fs.writeFileSync(headFile, `ref: refs/heads/${config.branch}\n`);
	return dir;
}

function readFileIfExists(file) {
	try {
		return fs.readFileSync(file, "utf8");
	} catch {
		return undefined;
	}
}

/** Copy the local synced files into the working copy, normalizing line endings. */
async function stageLocalIntoRepo(home, dir, log) {
	const rels = syncedRels(home);
	const staged = [];
	for (const rel of rels) {
		const content = readFileIfExists(path.join(home, rel));
		const target = path.join(dir, ...rel.split("/"));
		if (content === undefined) {
			if (fs.existsSync(target)) {
				fs.rmSync(target, { force: true });
				try {
					await git.remove({ fs, dir, filepath: rel });
				} catch {}
			}
			continue;
		}
		fs.mkdirSync(path.dirname(target), { recursive: true });
		const normalized = normalizeText(content);
		if (readFileIfExists(target) !== normalized) {
			fs.writeFileSync(target, normalized);
			staged.push(rel);
		}
	}
	fs.writeFileSync(path.join(dir, ".gitattributes"), GITATTRIBUTES_CONTENT);
	fs.writeFileSync(path.join(dir, ".sync-meta.yaml"), `${yaml.dump({
		dshVersion: localDshVersion(),
		pushedAt: new Date().toISOString(),
		device: deviceId(home)
	})}\n`);
	if (log !== undefined) for (const rel of staged) log(`staged ${rel}`);
	return staged;
}

function isNonFastForward(error) {
	if (typeof error !== "object" || error === null) return false;
	if (error.data?.code === "PushRejectedNonFastForward" || error.data?.code === "FastForwardError") return true;
	return error instanceof Error && /not a simple fast-forward|non-fast-forward|fast-forward/i.test(error.message);
}

/** Push the local configuration to the remote repository. */
export async function pushSync(options) {
	const { home, token, log } = options;
	const config = readSyncConfig(home);
	const settingsText = readFileIfExists(path.join(home, "settings.yaml"));
	if (settingsText === undefined) throw new SyncError("settings.yaml 不存在，无可同步内容", "NO_SETTINGS");
	assertNoSensitiveKeys(settingsText, config.sensitiveKeyPatterns);
	const dir = await ensureRepo(home, config, token);
	const staged = await stageLocalIntoRepo(home, dir, log);
	const candidates = [...syncedRels(home), ".gitattributes", ".sync-meta.yaml"];
	const statuses = new Map();
	for (const rel of candidates) statuses.set(rel, await git.status({ fs, dir, filepath: rel }));
	const pending = [...statuses.values()].some((status) => status !== "unmodified" && status !== "absent" && status !== "ignored");
	if (pending) {
		for (const rel of candidates) {
			const status = statuses.get(rel);
			if (status === "absent" || status === "ignored") continue;
			if (status === "deleted") {
				try {
					await git.remove({ fs, dir, filepath: rel });
				} catch {}
			} else {
				try {
					await git.add({ fs, dir, filepath: rel });
				} catch {}
			}
		}
		const message = `sync(${deviceId(home)}): ${new Date().toISOString()}`;
		const author = { name: AUTH_NAME, email: AUTH_EMAIL };
		const hasHead = await git.log({ fs, dir, depth: 1 }).then(() => true).catch(() => false);
		if (hasHead) {
			await git.commit({ fs, dir, message, author });
		} else {
			// First commit into an empty remote: no HEAD exists. Commit with an
			// explicit ref and no parents; the index supplies the tree.
			await git.commit({ fs, dir, message, author, ref: `refs/heads/${config.branch}`, parent: [] });
		}
	}
	await fetchRemote(dir, config, token);
	try {
		await git.push({
			fs,
			dir,
			url: config.remote,
			ref: config.branch,
			force: false,
			...transportOf(config.remote, token)
		});
	} catch (error) {
		if (isNonFastForward(error)) throw new SyncError("远端仓库已有其他设备推送的新提交，请先执行 pull 再 push", "PUSH_REJECTED");
		throw new SyncError(`推送失败：${error instanceof Error ? error.message : String(error)}`, "PUSH_FAILED");
	}
	return { pushed: pending, staged };
}

/** Shared spawn options: Windows shells .cmd/.ps1 wrappers through cmd.exe. */
function spawnOptions(timeoutMs) {
	return {
		encoding: "utf8",
		timeout: timeoutMs,
		windowsHide: true,
		shell: process.platform === "win32"
	};
}

function runPnpmInstall(profileDir) {
	const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
	const result = spawnSync(command, ["--dir", profileDir, "install"], spawnOptions(5 * 60 * 1000));
	if (result.error !== undefined) return { ok: false, detail: result.error.message };
	return { ok: result.status === 0, detail: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() };
}

/** Pull the remote configuration into the DSH home with backups and install linkage. */
export async function pullSync(options) {
	const { home, token, log } = options;
	const config = readSyncConfig(home);
	const dir = await ensureRepo(home, config, token);
	try {
		await git.pull({
			fs,
			dir,
			url: config.remote,
			ref: config.branch,
			singleBranch: true,
			fastForwardOnly: true,
			author: { name: AUTH_NAME, email: AUTH_EMAIL },
			...transportOf(config.remote, token)
		});
	} catch (error) {
		const conflict = isNonFastForward(error) || (error instanceof Error && /merge|conflict/i.test(error.message));
		if (conflict) throw new SyncError("本地同步工作区与远端分叉；删除 ~/.dsh/sync-state/repo 后重试 pull 即可（不会丢失任何 DSH 配置）", "LOCAL_DIVERGED");
		throw new SyncError(`拉取失败：${error instanceof Error ? error.message : String(error)}`, "PULL_FAILED");
	}

	const rels = syncedRels(dir);
	const backups = [];
	const written = [];
	const changedProfiles = new Set();
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	for (const rel of rels) {
		const incoming = readFileIfExists(path.join(dir, ...rel.split("/")));
		if (incoming === undefined) continue;
		const target = path.join(home, ...rel.split("/"));
		const current = readFileIfExists(target);
		const profile = rel.split("/")[1];
		// Compare line-normalized: a trailing newline or CRLF difference is not
		// a real local change and must neither back up nor rewrite the file.
		const differs = current === undefined || normalizeText(current) !== incoming;
		if (rel.endsWith("package.json") || rel.endsWith("pnpm-lock.yaml")) changedProfiles.add(profile);
		if (differs && current !== undefined) {
			const backup = `${target}.local-backup-${timestamp}`;
			fs.mkdirSync(path.dirname(target), { recursive: true });
			fs.writeFileSync(backup, current);
			backups.push(backup);
			written.push(rel);
		} else if (current === undefined) {
			written.push(rel);
		}
		if (differs) {
			fs.mkdirSync(path.dirname(target), { recursive: true });
			fs.writeFileSync(target, incoming);
			if (log !== undefined) log(`wrote ${rel}`);
		}
	}

	const warnings = [];
	const meta = readYamlOr(path.join(dir, ".sync-meta.yaml"), {});
	const remoteVersion = typeof meta === "object" && meta !== null ? meta.dshVersion : undefined;
	const localVersion = localDshVersion();
	if (typeof remoteVersion === "string" && remoteVersion !== "" && localVersion !== "unknown" && remoteVersion !== localVersion) warnings.push(`远端配置由 DSH ${remoteVersion} 推送，本机为 ${localVersion}，建议升级到一致版本`);

	// Re-read the config AFTER the pulled settings.yaml was applied: the
	// auto-install switch must follow the pulled value, not the pre-pull one.
	const applied = readSyncConfig(home);
	const installed = [];
	if (applied.autoInstallPlugins) {
		// Install when this pull changed a profile's manifests, or when a
		// profile has never been installed (fresh device / earlier pull with
		// the switch off).
		const targets = new Set(changedProfiles);
		for (const rel of rels) {
			const profile = rel.split("/")[1];
			if (profile !== undefined && !fs.existsSync(path.join(home, "profiles", profile, "node_modules"))) targets.add(profile);
		}
		for (const profile of targets) {
			const profileDir = path.join(home, "profiles", profile);
			if (!fs.existsSync(path.join(profileDir, "package.json"))) continue;
			if (log !== undefined) log(`installing plugins for profile ${profile} (pnpm install)...`);
			const result = runPnpmInstall(profileDir);
			if (!result.ok) throw new SyncError(`插件安装失败（profile ${profile}）：${result.detail}`, "INSTALL_FAILED");
			installed.push(profile);
		}
	}

	return { written, backups, installed, warnings };
}

/** Report the sync posture without mutating anything. */
export async function statusSync(options) {
	const { home, token } = options;
	const config = readSyncConfig(home);
	const dir = repoDir(home);
	const tokenPresent = readToken(home, config.credentialRef) !== undefined;
	const repoExists = fs.existsSync(path.join(dir, ".git"));
	const report = {
		configured: config.remote !== "",
		remote: config.remote,
		branch: config.branch,
		credentialRef: config.credentialRef,
		tokenPresent,
		autoInstallPlugins: config.autoInstallPlugins,
		repoExists,
		dshVersion: localDshVersion(),
		lastCommit: undefined,
		files: []
	};
	if (!repoExists) return report;
	try {
		const log = await git.log({ fs, dir, depth: 1 });
		const head = log[0];
		if (head !== undefined) report.lastCommit = { message: head.commit.message, committedAt: head.commit.committer.timestamp * 1000, oid: head.oid };
	} catch {}
	const repoRels = syncedRels(dir);
	const allRels = [...new Set([...syncedRels(home), ...repoRels])];
	for (const rel of allRels) {
		const local = readFileIfExists(path.join(home, ...rel.split("/")));
		const remote = readFileIfExists(path.join(dir, ...rel.split("/")));
		if (local === undefined && remote === undefined) continue;
		const state = local === undefined ? "missing-local" : remote === undefined ? "local-only" : normalizeText(local) === remote ? "in-sync" : "changed-local";
		report.files.push({ rel, state });
	}
	return report;
}

export { ensureRepo, httpAuth };
