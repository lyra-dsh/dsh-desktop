window.__ModuleLoader__.load({
	id: "@omnilyra/desktop-opener",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const React = require("react");
		const { createElement, Fragment, useState, useEffect } = React;

		// 注入 hover / 聚焦态样式（内联 style 无法表达 :hover，参考 session-log-export 的做法）。
		const css = ".dop-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}.dop-item:hover{background:var(--dsw-alias-interactive-bg-hover)}.dop-item:disabled{color:var(--dsw-alias-label-dimmed);cursor:wait}";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=\"@omnilyra/desktop-opener\"]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@omnilyra/desktop-opener";
			tag.dataset.pluginCss = "@omnilyra/desktop-opener";
			tag.textContent = css;
			document.head.appendChild(tag);
		}

		function iconUrl(editorId) {
			return "/api/desktop.editor-icon?editorId=" + encodeURIComponent(editorId);
		}

		/**
		 * 会话头部「用外部编辑器打开」控件（split-button）：
		 *   - 左半（图标 + 名字）＝用当前选中编辑器一键打开工作区
		 *   - 右半（▾）＝展开下拉换编辑器（换完即记住偏好）
		 * props.sessionId 由会话头部槽位注入。
		 */
		function OpenWithHeaderAction(props) {
			const { sessionId } = props;
			const [open, setOpen] = useState(false);
			const [editors, setEditors] = useState([]);
			const [preferredId, setPreferredId] = useState(null);

			useEffect(() => {
				let cancelled = false;
				fetch("/api/desktop.editors")
					.then((r) => r.json())
					.then((d) => { if (!cancelled && d && Array.isArray(d.editors)) setEditors(d.editors); })
					.catch(() => {});
				fetch("/api/desktop.editor-preference")
					.then((r) => r.json())
					.then((d) => { if (!cancelled && d && typeof d.editorId === "string") setPreferredId(d.editorId); })
					.catch(() => {});
				return () => { cancelled = true; };
			}, []);

			const current = editors.find((e) => e.id === preferredId) || editors[0] || null;

			const openWith = (editorId) => {
				fetch("/api/desktop.open-with", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ editorId, sessionId }),
				}).catch(() => {});
			};

			const selectEditor = (editorId) => {
				setPreferredId(editorId);
				setOpen(false);
				fetch("/api/desktop.editor-preference", {
					method: "PUT",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ editorId }),
				}).catch(() => {});
			};

			// 与「Session 日志」胶囊按钮保持一致的视觉。
			const splitStyle = {
				position: "relative",
				display: "inline-flex",
				alignItems: "center",
				border: "0.5px solid var(--dsw-alias-border-l4)",
				borderRadius: "18px",
				overflow: "hidden",
				height: "32px",
				fontFamily: "var(--dsw-font-family)",
				color: "var(--dsw-alias-label-primary)",
			};
			const btnStyle = {
				background: "transparent",
				border: "none",
				cursor: "pointer",
				color: "inherit",
				display: "inline-flex",
				alignItems: "center",
				gap: "6px",
				padding: "0 10px",
				height: "100%",
				fontSize: "13px",
				fontWeight: "400",
				lineHeight: "20px",
			};
			const caretStyle = {
				...btnStyle,
				padding: "0 7px",
				gap: "0px",
				borderLeft: "0.5px solid var(--dsw-alias-border-l4)",
			};
			const iconStyle = { width: "16px", height: "16px", borderRadius: "3px", display: "block", flex: "none" };
			const menuStyle = {
				position: "absolute",
				top: "calc(100% + 6px)",
				right: 0,
				zIndex: 1000,
				background: "var(--dsw-alias-bg-layer-2)",
				border: "0.5px solid var(--dsw-alias-border-l4)",
				borderRadius: "8px",
				boxShadow: "0 4px 16px rgba(0,0,0,.18)",
				padding: "4px",
				minWidth: "176px",
			};
			const itemStyle = {
				display: "flex",
				alignItems: "center",
				gap: "8px",
				width: "100%",
				border: "none",
				background: "transparent",
				textAlign: "left",
				padding: "7px 10px",
				cursor: "pointer",
				fontSize: "13px",
				lineHeight: "20px",
				color: "var(--dsw-alias-label-primary)",
				borderRadius: "6px",
			};
			const checkStyle = { marginLeft: "auto", color: "var(--dsw-alias-label-dimmed)", fontSize: "12px" };

			return createElement(Fragment, null,
				createElement("span", { style: splitStyle },
					createElement("button", {
						type: "button",
						className: "dop-btn",
						style: btnStyle,
						title: current ? "用 " + current.label + " 打开工作区" : "用外部编辑器打开工作区",
						onClick: () => { if (current) openWith(current.id); },
					},
						current && createElement("img", {
							src: iconUrl(current.id),
							alt: "",
							width: 16,
							height: 16,
							style: iconStyle,
							onError: (e) => { e.target.style.display = "none"; },
						}),
						createElement("span", null, current ? current.label : "打开项目")
					),
					createElement("button", {
						type: "button",
						className: "dop-btn",
						style: caretStyle,
						title: "选择编辑器",
						"aria-haspopup": "true",
						"aria-expanded": open,
						onClick: () => setOpen((v) => !v),
					}, createElement("span", { style: { fontSize: "10px", lineHeight: "1" } }, "▾")),
					open && createElement("div", { style: menuStyle },
						editors.length === 0
							? createElement("div", { style: { padding: "6px 8px", color: "var(--dsw-alias-label-dimmed)", fontSize: "12px" } }, "未检测到编辑器")
							: editors.map((e) => createElement("button", {
								key: e.id,
								type: "button",
								className: "dop-item",
								style: itemStyle,
								onClick: () => selectEditor(e.id),
							},
								createElement("img", {
									src: iconUrl(e.id),
									alt: "",
									width: 16,
									height: 16,
									style: iconStyle,
									onError: (e) => { e.target.style.display = "none"; },
								}),
								createElement("span", null, e.label),
								e.id === (current && current.id) ? createElement("span", { style: checkStyle }, "✓") : null
							))
					)
				)
			);
		}

		const inject = ["slots"];

		function apply(ctx) {
			ctx.slots.inject("conversation.session.header.utilities", () => ctx.slots.register({
				name: "conversation.session.header.utilities",
				id: "desktop-opener",
				inject: () => ({}),
			}, OpenWithHeaderAction));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
