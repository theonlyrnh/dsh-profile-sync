window.__ModuleLoader__.load({
	id: "dsh-profile-sync",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/client/section.js
		/** Locale dictionary namespace owned by this plugin. */
		const NS = "sync";
		const DICT = {
			zh: {
				nav: "配置同步",
				title: "多设备配置同步",
				desc: "把模型配置、插件清单、补丁层与锁文件同步到私有 Git 仓库。API Key 永不上传。",
				remote: "仓库地址",
				remotePlaceholder: "https://github.com/<owner>/<repo>.git",
				branch: "分支",
				autoInstallPlugins: "拉取后自动安装插件",
				save: "保存配置",
				saved: "已保存",
				token: "仓库访问 Token",
				tokenPlaceholder: "粘贴 fine-grained PAT，仅当前设备保存",
				tokenSave: "保存 Token",
				tokenPresent: "Token 已配置",
				tokenMissing: "Token 未配置",
				push: "上传（push）",
				pull: "下载（pull）",
				refresh: "刷新状态",
				busyPush: "上传中…",
				busyPull: "下载中…",
				notConfigured: "尚未配置仓库地址：填写后保存，再粘贴 Token 即可使用。",
				repo: "本地同步仓库",
				repoCloned: "已克隆",
				repoMissing: "未克隆（首次 push/pull 时自动创建）",
				lastCommit: "上次提交",
				files: "文件状态",
				stateInSync: "一致",
				stateChangedLocal: "本地有改动",
				stateMissingLocal: "仅远端有",
				stateLocalOnly: "仅本地有"
			},
			en: {
				nav: "Sync",
				title: "Multi-device config sync",
				desc: "Sync model settings, plugin manifests, patch layers and lockfiles to a private Git repository. API keys are never uploaded.",
				remote: "Repository URL",
				remotePlaceholder: "https://github.com/<owner>/<repo>.git",
				branch: "Branch",
				autoInstallPlugins: "Auto-install plugins after pull",
				save: "Save config",
				saved: "Saved",
				token: "Repository token",
				tokenPlaceholder: "Paste a fine-grained PAT; stored on this device only",
				tokenSave: "Save token",
				tokenPresent: "Token configured",
				tokenMissing: "Token missing",
				push: "Push",
				pull: "Pull",
				refresh: "Refresh",
				busyPush: "Pushing…",
				busyPull: "Pulling…",
				notConfigured: "No repository URL yet: save one and paste the token, then sync.",
				repo: "Local sync repo",
				repoCloned: "Cloned",
				repoMissing: "Not cloned (created on first push/pull)",
				lastCommit: "Last commit",
				files: "File states",
				stateInSync: "In sync",
				stateChangedLocal: "Changed locally",
				stateMissingLocal: "Remote only",
				stateLocalOnly: "Local only"
			}
		};
		const STATE_KEYS = {
			"in-sync": "stateInSync",
			"changed-local": "stateChangedLocal",
			"missing-local": "stateMissingLocal",
			"local-only": "stateLocalOnly"
		};
		const SECTION_CSS = `
.__dshSync_section{flex-direction:column;gap:14px;width:100%;max-width:720px;display:flex}
.__dshSync_card{background:var(--dsw-alias-bg-module-platform);border-radius:16px;flex-direction:column;gap:12px;padding:16px;display:flex}
.__dshSync_label{color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;flex-direction:column;gap:4px;display:flex}
.__dshSync_input{box-sizing:border-box;background:var(--dsw-specific-menu);border:.5px solid var(--dsw-alias-border-l3);border-radius:8px;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;padding:7px 10px;width:100%}
.__dshSync_row{align-items:center;gap:10px;display:flex;flex-wrap:wrap}
.__dshSync_btn{height:32px;font:inherit;font-size:13px;line-height:20px;cursor:pointer;border-radius:16px;border:.5px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-primary);background:transparent;padding:0 14px}
.__dshSync_btnPrimary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);border:none}
.__dshSync_btn:disabled{opacity:.5;cursor:default}
.__dshSync_msg{color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;white-space:pre-wrap;word-break:break-all;margin:0}
.__dshSync_err{color:var(--dsw-alias-state-error-primary)}
.__dshSync_ok{color:var(--dsw-alias-state-success-primary)}
.__dshSync_fileRow{justify-content:space-between;gap:12px;display:flex;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);border-bottom:.5px solid var(--dsw-alias-border-l4);padding:4px 0}
.__dshSync_muted{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px;margin:0}
.__dshSync_h2{color:var(--dsw-alias-label-primary);margin:0;font-size:16px;font-weight:500;line-height:24px}
`;
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=\"dsh-profile-sync-section\"]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-profile-sync";
			tag.dataset.pluginCss = "dsh-profile-sync-section";
			tag.textContent = SECTION_CSS;
			document.head.appendChild(tag);
		}
		const post = async (path, body) => {
			const response = await fetch(path, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body ?? {})
			});
			return await response.json();
		};
		/** Bound translate, installed by apply() before the slot registers. */
		let translate = (key) => DICT.zh[key] ?? key;
		const tState = (state) => translate(STATE_KEYS[state] ?? "stateInSync");
		/**
		 * The sync card: configuration inputs, token input, push/pull buttons,
		 * and the status report. All host work goes through the /api/sync routes
		 * registered by the host half.
		 */
		function SyncSection() {
			const t = translate;
			const [report, setReport] = (0, react.useState)(undefined);
			const [busy, setBusy] = (0, react.useState)("");
			const [message, setMessage] = (0, react.useState)(undefined);
			const [messageKind, setMessageKind] = (0, react.useState)("ok");
			const [remote, setRemote] = (0, react.useState)("");
			const [branch, setBranch] = (0, react.useState)("main");
			const [autoInstall, setAutoInstall] = (0, react.useState)(true);
			const [token, setToken] = (0, react.useState)("");
			const refresh = (0, react.useCallback)(async () => {
				try {
					const body = await fetch("/api/sync/status").then((res) => res.json());
					if (body.ok === true) {
						setReport(body.report);
						if (body.report.configured) {
							setRemote(body.report.remote);
							setBranch(body.report.branch);
							setAutoInstall(body.report.autoInstallPlugins);
						}
					}
				} catch {}
			}, []);
			(0, react.useEffect)(() => {
				refresh();
			}, [refresh]);
			const fail = (body) => {
				setMessage(body.message ?? "failed");
				setMessageKind("error");
			};
			const runAction = async (action) => {
				setBusy(action);
				setMessage(undefined);
				try {
					const body = await post(`/api/sync/${action}`);
					if (body.ok === true) {
						setMessage(body.message ?? "ok");
						setMessageKind("ok");
					} else fail(body);
				} catch (error) {
					setMessage(error instanceof Error ? error.message : String(error));
					setMessageKind("error");
				} finally {
					setBusy("");
					await refresh();
				}
			};
			const saveConfig = async () => {
				setBusy("config");
				setMessage(undefined);
				try {
					const body = await post("/api/sync/config", { remote, branch, autoInstallPlugins: autoInstall });
					if (body.ok === true) {
						setMessage(t("saved"));
						setMessageKind("ok");
					} else fail(body);
				} catch (error) {
					setMessage(error instanceof Error ? error.message : String(error));
					setMessageKind("error");
				} finally {
					setBusy("");
					await refresh();
				}
			};
			const saveToken = async () => {
				setBusy("token");
				setMessage(undefined);
				try {
					const body = await post("/api/sync/token", { value: token });
					if (body.ok === true) {
						setToken("");
						setMessage(t("saved"));
						setMessageKind("ok");
					} else fail(body);
				} catch (error) {
					setMessage(error instanceof Error ? error.message : String(error));
					setMessageKind("error");
				} finally {
					setBusy("");
					await refresh();
				}
			};
			return (0, react_jsx_runtime.jsxs)("div", {
				className: "__dshSync_section",
				children: [
					(0, react_jsx_runtime.jsx)("h2", { className: "__dshSync_h2", children: t("title") }),
					(0, react_jsx_runtime.jsx)("p", { className: "__dshSync_muted", children: t("desc") }),
					(0, react_jsx_runtime.jsxs)("div", {
						className: "__dshSync_card",
						children: [
							(0, react_jsx_runtime.jsx)("label", {
								className: "__dshSync_label",
								children: [t("remote"), (0, react_jsx_runtime.jsx)("input", {
									className: "__dshSync_input",
									type: "text",
									value: remote,
									placeholder: t("remotePlaceholder"),
									onChange: (event) => setRemote(event.target.value)
								})]
							}),
							(0, react_jsx_runtime.jsx)("label", {
								className: "__dshSync_label",
								children: [t("branch"), (0, react_jsx_runtime.jsx)("input", {
									className: "__dshSync_input",
									type: "text",
									value: branch,
									onChange: (event) => setBranch(event.target.value)
								})]
							}),
							(0, react_jsx_runtime.jsxs)("label", {
								className: "__dshSync_row",
								children: [(0, react_jsx_runtime.jsx)("input", {
									type: "checkbox",
									checked: autoInstall,
									onChange: (event) => setAutoInstall(event.target.checked)
								}), t("autoInstallPlugins")]
							}),
							(0, react_jsx_runtime.jsx)("div", {
								className: "__dshSync_row",
								children: (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "__dshSync_btn __dshSync_btnPrimary",
									disabled: busy !== "",
									onClick: saveConfig,
									children: t("save")
								})
							}),
							(0, react_jsx_runtime.jsx)("label", {
								className: "__dshSync_label",
								children: [report?.tokenPresent === true ? t("tokenPresent") : t("tokenMissing"), (0, react_jsx_runtime.jsx)("input", {
									className: "__dshSync_input",
									type: "password",
									value: token,
									placeholder: t("tokenPlaceholder"),
									onChange: (event) => setToken(event.target.value)
								})]
							}),
							(0, react_jsx_runtime.jsx)("div", {
								className: "__dshSync_row",
								children: [
									(0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: "__dshSync_btn",
										disabled: busy !== "",
										onClick: saveToken,
										children: t("tokenSave")
									}),
									(0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: "__dshSync_btn __dshSync_btnPrimary",
										disabled: busy !== "",
										onClick: () => runAction("push"),
										children: busy === "push" ? t("busyPush") : t("push")
									}),
									(0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: "__dshSync_btn",
										disabled: busy !== "",
										onClick: () => runAction("pull"),
										children: busy === "pull" ? t("busyPull") : t("pull")
									}),
									(0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: "__dshSync_btn",
										disabled: busy !== "",
										onClick: refresh,
										children: t("refresh")
									})
								]
							}),
							message !== undefined ? (0, react_jsx_runtime.jsx)("p", {
								className: `__dshSync_msg ${messageKind === "error" ? "__dshSync_err" : "__dshSync_ok"}`,
								children: message
							}) : null,
							report?.configured !== true ? (0, react_jsx_runtime.jsx)("p", {
								className: "__dshSync_muted",
								children: t("notConfigured")
							}) : null
						]
					}),
					report !== undefined ? (0, react_jsx_runtime.jsxs)("div", {
						className: "__dshSync_card",
						children: [
							(0, react_jsx_runtime.jsxs)("p", {
								className: "__dshSync_msg",
								children: [t("repo"), ": ", report.repoExists ? t("repoCloned") : t("repoMissing")]
							}),
							report.lastCommit !== undefined ? (0, react_jsx_runtime.jsxs)("p", {
								className: "__dshSync_msg",
								children: [t("lastCommit"), ": ", new Date(report.lastCommit.committedAt).toLocaleString(), " — ", report.lastCommit.message]
							}) : null,
							report.files.length > 0 ? (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, {
								children: [
									(0, react_jsx_runtime.jsx)("p", { className: "__dshSync_muted", children: t("files") }),
									report.files.map((file) => (0, react_jsx_runtime.jsxs)("div", {
										key: file.rel,
										className: "__dshSync_fileRow",
										children: [(0, react_jsx_runtime.jsx)("span", { children: file.rel }), (0, react_jsx_runtime.jsx)("span", {
											className: file.state === "in-sync" ? "__dshSync_ok" : "__dshSync_muted",
											children: tState(file.state)
										})]
									}))
								]
							}) : null
						]
					}) : null
				]
			});
		}
		//#endregion
		//#region src/client/index.js
		/**
		 * dsh-profile-sync client half: a new Settings page section (`settings.section`
		 * slot, id "sync") with the sync card. Locale dictionaries register under
		 * the "sync" namespace, zh and en.
		 */
		const inject = ["slots", "locale"];
		function apply(ctx) {
			ctx.effect(() => [ctx.locale.register(NS, "zh", DICT.zh), ctx.locale.register(NS, "en", DICT.en)], "dsh-profile-sync: dictionary");
			translate = ctx.locale.bind(NS);
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "sync",
				order: 30,
				label: () => translate("nav"),
				locale: NS
			}, SyncSection));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
