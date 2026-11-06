window.__ModuleLoader__.load({
	id: "dsh-app-restart",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const React = require("react");

		const NS = "dsh-app-restart";
		const API_ROOT = "/dsh-app-restart";
		/** One click starts this countdown; a second click within it cancels. */
		const COUNTDOWN_SECONDS = 3;
		/**
		 * How long the button may stay in its restarting phase. The Host half only
		 * accepts the request; the detached helper can still refuse afterwards
		 * (wrong target process, leftover lock), leaving this page alive with a
		 * spinner that never resolves. After this window the button becomes
		 * retryable again instead of needing a page reload.
		 */
		const RESTART_TIMEOUT_MS = 20000;

		const DICTIONARY = {
			en: {
				refresh: "Reload",
				refreshHint: "Reload this page",
				action: "Restart",
				countdown: (seconds) => `Restart in ${seconds}s`,
				countdownHint: (seconds) => `Restarting in ${seconds}s — click to cancel`,
				restarting: "Restarting…",
				failed: "Restart failed",
				failedHint: (stage) => `Restart failed (${stage}) — click to retry`,
				unsupported: "Desktop only",
				unsupportedHint: "Restart is only available in the desktop app",
			},
			zh: {
				refresh: "刷新",
				refreshHint: "刷新页面",
				action: "重启",
				countdown: (seconds) => `${seconds} 秒后重启`,
				countdownHint: (seconds) => `${seconds} 秒后重启 —— 点击取消`,
				restarting: "正在重启…",
				failed: "重启失败",
				failedHint: (stage) => `重启失败（${stage}）—— 点击重试`,
				unsupported: "仅桌面",
				unsupportedHint: "仅桌面应用支持重启",
			},
		};

		function currentLanguage() {
			const languages =
				Array.isArray(navigator.languages) && navigator.languages.length > 0
					? navigator.languages
					: [navigator.language];
			const candidates = [document.documentElement.lang, ...languages];
			for (const candidate of candidates) {
				if (typeof candidate !== "string" || candidate.length === 0) continue;
				const lower = candidate.toLowerCase();
				if (lower.startsWith("zh")) return "zh";
				if (lower.startsWith("en")) return "en";
			}
			return "en";
		}

		function useLanguage() {
			const [language, setLanguage] = React.useState(currentLanguage);
			React.useEffect(() => {
				const sync = () => {
					const next = currentLanguage();
					setLanguage((previous) => (previous === next ? previous : next));
				};
				sync();
				const observer = new MutationObserver(sync);
				observer.observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });
				return () => observer.disconnect();
			}, []);
			return language;
		}

		/** Same-origin URL that also survives a reverse-proxy mount prefix. */
		function api(path) {
			const relative = path.replace(/^\/+/u, "");
			if (typeof document === "undefined") return `/${relative}`;
			return new URL(relative, document.baseURI).pathname;
		}

		async function readJson(response) {
			try {
				return await response.json();
			} catch {
				return null;
			}
		}

		async function fetchStatus() {
			const response = await fetch(api(`${API_ROOT}/status`), {
				credentials: "same-origin",
				cache: "no-store",
				redirect: "error",
			});
			const body = await readJson(response);
			if (!response.ok || body === null) throw new Error(`status-${response.status}`);
			return body;
		}

		/**
		 * Marks a request as coming from this package's own page. The desktop
		 * window's requests reach the Host through Electron's protocol forwarder,
		 * which deletes `origin`, so the Host cannot use that header to tell a
		 * same-origin page from anything else. A custom header is a safe
		 * substitute: sending one cross-origin requires a CORS preflight, and the
		 * restart route answers no preflight.
		 */
		const DESKTOP_HEADER = "x-dsh-app-restart";
		const DESKTOP_HEADER_VALUE = "dsh-app://app";

		async function postRestart() {
			const response = await fetch(api(`${API_ROOT}/restart`), {
				method: "POST",
				credentials: "same-origin",
				cache: "no-store",
				redirect: "error",
				headers: { "content-type": "application/json", [DESKTOP_HEADER]: DESKTOP_HEADER_VALUE },
				body: "{}",
			});
			const body = await readJson(response);
			if (!response.ok || body === null || body.ok !== true) {
				const reason =
					body !== null && typeof body.reason === "string" ? body.reason : `http-${response.status}`;
				throw new Error(reason);
			}
			return body;
		}

		function Glyph({ size, kind }) {
			const children =
				kind === "refresh"
					? [
							// A closed circular arrow: the refresh convention.
							React.createElement("path", { key: "arc", d: "M13 8a5 5 0 1 1-1.6-3.7" }),
							React.createElement("path", { key: "head", d: "M13 2.2v3.2h-3.2" }),
						]
					: [
							// An open arc with a bar through the gap, the restart motif,
							// so the two icons are not mistaken for each other.
							React.createElement("path", { key: "bar", d: "M8 1.8v3.4" }),
							React.createElement("path", { key: "arc", d: "M11.1 4a4.7 4.7 0 1 1-6.2 0" }),
						];
			return React.createElement(
				"svg",
				{
					"aria-hidden": true,
					className: "dsh-app-restart__icon",
					focusable: false,
					width: size,
					height: size,
					viewBox: "0 0 16 16",
					fill: "none",
					stroke: "currentColor",
					strokeWidth: 1.5,
					strokeLinecap: "round",
					strokeLinejoin: "round",
				},
				...children,
			);
		}

		/** Reload this page: the cheap recovery when only the page is stale. */
		function RefreshButton({ wide }) {
			const language = useLanguage();
			const dictionary = DICTIONARY[language] ?? DICTIONARY.en;
			const label = dictionary.refresh;
			return React.createElement(
				"button",
				{
					"aria-label": label,
					className: `dsh-app-restart__button${wide ? "" : " is-rail"}`,
					lang: language,
					title: dictionary.refreshHint,
					type: "button",
					onClick: () => window.location.reload(),
				},
				React.createElement(Glyph, { size: wide ? 15 : 18, kind: "refresh" }),
				wide ? React.createElement("span", { className: "dsh-app-restart__label" }, label) : undefined,
			);
		}

		function RestartButton({ wide }) {
			const language = useLanguage();
			const dictionary = DICTIONARY[language] ?? DICTIONARY.en;
			const [phase, setPhase] = React.useState("idle");
			const [remaining, setRemaining] = React.useState(0);
			const [stage, setStage] = React.useState("");

			// Ask the Host half once whether this window can restart the app at all,
			// and whether the previous attempt left a failure behind.
			React.useEffect(() => {
				let live = true;
				fetchStatus().then(
					(status) => {
						if (!live) return;
						if (status.supported !== true) {
							setPhase("unsupported");
							return;
						}
						const last = status.last;
						if (last !== null && typeof last === "object" && last.ok === false) {
							setStage(typeof last.stage === "string" ? last.stage : "unknown");
							setPhase("failed");
						}
					},
					() => {
						// A status probe failure must not disable a working button.
					},
				);
				return () => {
					live = false;
				};
			}, []);

			// The countdown is the only timer this component owns.
			React.useEffect(() => {
				if (phase !== "countdown") return undefined;
				if (remaining <= 0) {
					setPhase("restarting");
					postRestart().then(
						() => setPhase("restarting"),
						(error) => {
							setStage(error instanceof Error ? error.message : "unknown");
							setPhase("failed");
						},
					);
					return undefined;
				}
				const timer = window.setTimeout(() => setRemaining((value) => value - 1), 1000);
				return () => window.clearTimeout(timer);
			}, [phase, remaining]);

			// A restart that never arrives must not strand the button. If this page
			// is still alive and mounted after the window, the app did not go down:
			// surface whatever the helper recorded, or a plain timeout.
			React.useEffect(() => {
				if (phase !== "restarting") return undefined;
				let live = true;
				const timer = window.setTimeout(() => {
					fetchStatus().then(
						(status) => {
							if (!live) return;
							const last = status.last;
							const recorded =
								last !== null && typeof last === "object" && typeof last.stage === "string"
									? last.stage
									: "timeout";
							setStage(recorded);
							setPhase("failed");
						},
						() => {
							if (!live) return;
							setStage("timeout");
							setPhase("failed");
						},
					);
				}, RESTART_TIMEOUT_MS);
				return () => {
					live = false;
					window.clearTimeout(timer);
				};
			}, [phase]);

			const onClick = () => {
				if (phase === "unsupported") return;
				if (phase === "countdown") {
					// A second click cancels: nothing has been sent yet.
					setPhase("idle");
					setRemaining(0);
					return;
				}
				if (phase === "restarting") return;
				setStage("");
				setRemaining(COUNTDOWN_SECONDS);
				setPhase("countdown");
			};

			const label =
				phase === "countdown"
					? dictionary.countdown(remaining)
					: phase === "restarting"
						? dictionary.restarting
						: phase === "failed"
							? dictionary.failed
							: phase === "unsupported"
								? dictionary.unsupported
								: dictionary.action;

			// The rail has no room for a sentence, so the long form lives in the
			// title and accessible name while the visible text stays two characters.
			const hint =
				phase === "countdown"
					? dictionary.countdownHint(remaining)
					: phase === "restarting"
						? dictionary.restarting
						: phase === "failed"
							? dictionary.failedHint(stage === "" ? "unknown" : stage)
							: phase === "unsupported"
								? dictionary.unsupportedHint
								: dictionary.action;

			const button = React.createElement(
				"button",
				{
					"aria-live": "polite",
					"aria-label": hint,
					className: `dsh-app-restart__button${wide ? "" : " is-rail"}${phase === "countdown" ? " is-armed" : ""}${phase === "restarting" ? " is-busy" : ""}${phase === "failed" ? " is-failed" : ""}`,
					disabled: phase === "restarting" || phase === "unsupported",
					lang: language,
					title: hint,
					type: "button",
					onClick,
				},
				React.createElement(Glyph, { size: wide ? 15 : 18, kind: "restart" }),
				wide ? React.createElement("span", { className: "dsh-app-restart__label" }, label) : undefined,
			);

			return button;
		}

		/**
		 * The slot cell: reload on the left, restart on the right.
		 *
		 * The sidebar foot is a flex row, but it is only ~32px wide when the
		 * sidebar is a rail, so the pair stacks there instead of overflowing.
		 */
		function FooterActions({ wide }) {
			return React.createElement(
				"div",
				{ className: `dsh-app-restart__group${wide ? "" : " is-rail"}` },
				React.createElement(RefreshButton, { wide }),
				React.createElement(RestartButton, { wide }),
			);
		}

		const STYLES = `
.dsh-app-restart__group{display:flex;align-items:center;gap:4px;flex:1 1 auto;min-width:0}
.dsh-app-restart__group.is-rail{flex:0 0 auto;flex-direction:column;gap:6px;justify-content:center}
.dsh-app-restart__button{display:flex;flex:1 1 0;align-items:center;justify-content:center;gap:6px;min-width:0;min-height:32px;padding:0 8px;border:0;border-radius:var(--dsw-radius-md,8px);background:transparent;color:var(--dsw-alias-label-secondary,#4a5058);font-family:inherit;font-size:13px;line-height:20px;cursor:pointer;overflow:hidden;transition:background-color .12s ease,color .12s ease}
.dsh-app-restart__button:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));color:var(--dsw-alias-label-primary,#16181d)}
.dsh-app-restart__button:active{background:var(--dsw-alias-interactive-bg-active,rgba(127,127,127,.2))}
.dsh-app-restart__button:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary,currentColor));outline-offset:-2px}
.dsh-app-restart__button:disabled{cursor:default;opacity:.55}
.dsh-app-restart__button.is-armed{color:var(--dsw-alias-state-warn-primary,#b4690e)}
.dsh-app-restart__button.is-armed:hover{background:var(--dsw-alias-state-warn-primary,#b4690e);color:var(--dsw-alias-bg-base,#fff)}
.dsh-app-restart__button.is-failed{color:var(--dsw-alias-state-error-primary,#c4342d)}
.dsh-app-restart__button.is-busy{cursor:progress;opacity:.7}
.dsh-app-restart__button.is-rail{flex:0 0 auto;width:36px;height:36px;min-height:0;padding:0;justify-content:center;gap:0;border-radius:var(--dsw-radius-md,8px)}
.dsh-app-restart__icon{display:block;flex:none}
.dsh-app-restart__button.is-busy .dsh-app-restart__icon{animation:dsh-app-restart-spin 1.1s linear infinite}
.dsh-app-restart__label{min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
@keyframes dsh-app-restart-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.dsh-app-restart__button{transition:none}.dsh-app-restart__button.is-busy .dsh-app-restart__icon{animation:none}}
`;

		const inject = ["slots"];

		function apply(ctx) {
			ctx.effect(() => {
				const style = document.createElement("style");
				style.dataset.plugin = NS;
				style.textContent = STYLES;
				document.head.append(style);
				return () => style.remove();
			}, "dsh-app-restart: styles");

			ctx.effect(
				() =>
					ctx.slots.inject("sidebar.footer.action", () =>
						ctx.slots.register({ name: "sidebar.footer.action", id: NS, order: 90 }, FooterActions),
					),
				"dsh-app-restart: sidebar footer action",
			);
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
