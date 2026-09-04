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

		/**
		 * 会话头部「打开项目」按钮：点击展开已安装编辑器列表，选中后调 host 路由打开工作区。
		 * props.sessionId 由会话头部槽位注入；props.openWith 由下方 inject() 注入。
		 */
		function OpenWithHeaderAction(props) {
			const { sessionId, openWith } = props;
			const [open, setOpen] = useState(false);
			const [editors, setEditors] = useState([]);

			useEffect(() => {
				let cancelled = false;
				fetch("/api/desktop.editors")
					.then((r) => r.json())
					.then((d) => { if (!cancelled && d && Array.isArray(d.editors)) setEditors(d.editors); })
					.catch(() => {});
				return () => { cancelled = true; };
			}, []);

			// 与「Session 日志」胶囊按钮保持一致的视觉，便于并排放在会话头部。
			const btnStyle = {
				border: "0.5px solid var(--dsw-alias-border-l4)",
				height: "32px",
				color: "var(--dsw-alias-label-primary)",
				fontFamily: "var(--dsw-font-family)",
				cursor: "pointer",
				background: "0 0",
				borderRadius: "18px",
				justifyContent: "center",
				alignItems: "center",
				gap: "4px",
				padding: "6px 12px",
				fontSize: "13px",
				fontWeight: "400",
				lineHeight: "20px",
				display: "inline-flex",
			};
			const menuStyle = {
				position: "absolute",
				top: "calc(100% + 6px)",
				right: 0,
				zIndex: 1000,
				background: "var(--dsw-alias-bg-container, #fff)",
				border: "0.5px solid var(--dsw-alias-border-l4, #ddd)",
				borderRadius: "8px",
				boxShadow: "0 4px 16px rgba(0,0,0,.18)",
				padding: "4px",
				minWidth: "168px",
			};
			const itemStyle = {
				display: "block",
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

			return createElement(Fragment, null,
				createElement("span", { style: { position: "relative", display: "inline-flex" } },
					createElement("button", {
						type: "button",
						className: "dop-btn",
						style: btnStyle,
						title: "用外部编辑器打开当前工作区",
						onClick: () => setOpen((v) => !v),
					}, "打开项目"),
					open && createElement("div", { style: menuStyle },
						editors.length === 0
							? createElement("div", { style: { padding: "6px 8px", color: "var(--dsw-alias-label-dimmed)", fontSize: "12px" } }, "未检测到编辑器")
							: editors.map((e) => createElement("button", {
								key: e.id,
								type: "button",
								className: "dop-item",
								style: itemStyle,
								onClick: () => { setOpen(false); openWith(e.id, sessionId); },
							}, e.label))
					)
				)
			);
		}

		const inject = ["slots"];

		function apply(ctx) {
			ctx.slots.inject("conversation.session.header.utilities", () => ctx.slots.register({
				name: "conversation.session.header.utilities",
				id: "desktop-opener",
				inject: () => ({
					openWith: (editorId, sessionId) => {
						fetch("/api/desktop.open-with", {
							method: "POST",
							headers: { "content-type": "application/json" },
							body: JSON.stringify({ editorId, sessionId }),
						}).catch(() => {});
					},
				}),
			}, OpenWithHeaderAction));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
