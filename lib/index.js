/**
 * dsh-profile-sync host plugin: registers the `/api/sync` HTTP endpoints and the
 * `dsh-profile-sync` settings section. Mounted into the web profile by
 * cordis.patch.yml (`inject: [webServer]`).
 *
 * Security posture:
 *   - token lives in the DSH credential seam, never in settings or logs
 *   - endpoints refuse cross-site requests (CSRF) and never return the token
 *   - push refuses settings.yaml entries whose keys match the sensitive
 *     patterns configured in the section
 * @module dsh-profile-sync
 */
import z from "@deepseek-ai/schemastery";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { DEFAULT_CONFIG, dshHome, pullSync, pushSync, readSyncConfig, statusSync, SyncError } from "./core.js";

/** Stable Cordis plugin name (host composition row id). */
export const name = "dsh-profile-sync";
/** Services required before apply. */
export const inject = ["webServer"];
/** Settings section schema; the entry carries the defaults. */
export const Config = z.object({
	remote: z.string().default(DEFAULT_CONFIG.remote),
	branch: z.string().default(DEFAULT_CONFIG.branch),
	credentialRef: z.string().pattern(/^[A-Za-z_][A-Za-z0-9_]*$/).default(DEFAULT_CONFIG.credentialRef),
	autoInstallPlugins: z.boolean().default(DEFAULT_CONFIG.autoInstallPlugins),
	sensitiveKeyPatterns: z.array(z.string()).default(DEFAULT_CONFIG.sensitiveKeyPatterns)
});

const json = (res, status, body) => {
	res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
	res.end(JSON.stringify(body));
};
const readBody = async (req) => {
	const chunks = [];
	for await (const chunk of req) chunks.push(chunk);
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		return {};
	}
};
const sameSiteOnly = (req, res) => {
	if (req.headers["sec-fetch-site"] === "cross-site") {
		json(res, 403, { ok: false, message: "cross-site requests are refused" });
		return false;
	}
	return true;
};
const errorMessage = (error) => error instanceof SyncError ? error.message : error instanceof Error ? error.message : String(error);

export function apply(ctx) {
	const server = ctx.webServer;
	const log = ctx.logger("dsh-profile-sync");
	const home = dshHome();

	let source = () => structuredClone(DEFAULT_CONFIG);
	ctx.inject(["settings"], (settingsCtx) => {
		settingsCtx.settings.installSection(ctx, "dsh-profile-sync", Config, structuredClone(DEFAULT_CONFIG), {
			setSource(current) {
				source = current;
			},
			onChange() {
				log.info("dsh-profile-sync settings changed");
			},
			validate(value) {
				if (value.branch === "") throw new Error("dsh-profile-sync: branch must not be empty");
			}
		});
	});

	const resolveToken = async () => {
		const config = source();
		const credentials = ctx.get("credentials");
		if (credentials === undefined) return undefined;
		const resolved = await credentials.resolve(credentialRef(config.credentialRef));
		return typeof resolved?.value === "string" && resolved.value.length > 0 ? resolved.value : undefined;
	};

	const run = async (action) => {
		const config = source();
		const token = await resolveToken();
		const logger = (line) => log.info(line);
		const result = action === "push" ? await pushSync({ home, token, log: logger }) : await pullSync({ home, token, log: logger });
		return {
			ok: true,
			message: action === "push" ? (result.pushed ? `已推送 ${result.staged.length} 个变更文件` : "无变化，无需推送") : `已应用 ${result.written.length} 个文件`,
			result
		};
	};

	ctx.effect(() => {
		const disposers = [
			server.register({
				kind: "exact",
				path: "/api/sync/status",
				handler: async (req, res) => {
					if (!sameSiteOnly(req, res)) return;
					try {
						const token = await resolveToken();
						json(res, 200, { ok: true, report: await statusSync({ home, token }) });
					} catch (error) {
						json(res, 500, { ok: false, message: errorMessage(error) });
					}
				}
			}),
			server.register({
				kind: "exact",
				path: "/api/sync/push",
				handler: async (req, res) => {
					if (!sameSiteOnly(req, res)) return;
					if (req.method !== "POST") {
						json(res, 405, { ok: false, message: "POST only" });
						return;
					}
					try {
						json(res, 200, await run("push"));
					} catch (error) {
						log.error(`push failed: ${errorMessage(error)}`);
						json(res, 500, { ok: false, message: errorMessage(error) });
					}
				}
			}),
			server.register({
				kind: "exact",
				path: "/api/sync/pull",
				handler: async (req, res) => {
					if (!sameSiteOnly(req, res)) return;
					if (req.method !== "POST") {
						json(res, 405, { ok: false, message: "POST only" });
						return;
					}
					try {
						json(res, 200, await run("pull"));
					} catch (error) {
						log.error(`pull failed: ${errorMessage(error)}`);
						json(res, 500, { ok: false, message: errorMessage(error) });
					}
				}
			}),
			server.register({
				kind: "exact",
				path: "/api/sync/config",
				handler: async (req, res) => {
					if (!sameSiteOnly(req, res)) return;
					if (req.method !== "POST") {
						json(res, 405, { ok: false, message: "POST only" });
						return;
					}
					const body = await readBody(req);
					const settings = ctx.get("settings");
					if (settings === undefined) {
						json(res, 500, { ok: false, message: "settings service is unavailable" });
						return;
					}
					const allowed = ["remote", "branch", "credentialRef", "autoInstallPlugins", "sensitiveKeyPatterns"];
					const patch = {};
					for (const key of allowed) if (key in body) patch[key] = body[key];
					try {
						await settings.update("dsh-profile-sync", patch);
						json(res, 200, { ok: true });
					} catch (error) {
						json(res, 500, { ok: false, message: errorMessage(error) });
					}
				}
			}),
			server.register({
				kind: "exact",
				path: "/api/sync/token",
				handler: async (req, res) => {
					if (!sameSiteOnly(req, res)) return;
					if (req.method !== "POST") {
						json(res, 405, { ok: false, message: "POST only" });
						return;
					}
					const body = await readBody(req);
					const credentials = ctx.get("credentials");
					if (credentials === undefined) {
						json(res, 500, { ok: false, message: "credentials service is unavailable" });
						return;
					}
					try {
						const ref = credentialRef(source().credentialRef);
						if (typeof body.value === "string" && body.value.length > 0) await credentials.set(ref, body.value);
						else await credentials.unset(ref);
						json(res, 200, { ok: true });
					} catch (error) {
						json(res, 500, { ok: false, message: errorMessage(error) });
					}
				}
			})
		];
		return () => {
			for (const dispose of disposers) dispose();
		};
	}, "dsh-profile-sync: api routes");
}
