/**
 * HTML 转 Markdown 模块
 * 使用 Turndown 库，并配置自定义规则处理 Confluence 特有标签
 */
import TurndownService from "turndown";

/**
 * HTML 转 Markdown 转换器
 */
export class HtmlToMarkdownConverter {
	private turndown: TurndownService;

	constructor() {
		// 初始化 Turndown 服务
		this.turndown = new TurndownService({
			headingStyle: "atx",       // 使用 # 风格的标题
			bulletListMarker: "-",     // 使用 - 作为列表标记
			codeBlockStyle: "fenced",  // 使用围栏式代码块
			fence: "```",              // 使用 ``` 作为代码围栏
			emDelimiter: "*",          // 使用 * 作为斜体标记
			strongDelimiter: "**",     // 使用 ** 作为粗体标记
			linkStyle: "inlined",      // 行内链接
			linkReferenceStyle: "full", // 完整引用
		});

		// 配置自定义规则
		this.configureRules();
	}

	/**
	 * 配置 Turndown 自定义规则
	 */
	private configureRules(): void {
		// ==================== 1. 处理 Confluence 双链 ====================
		/**
		 * <ac:link> 标签处理
		 * 示例:
		 * <ac:link>
		 *   <ri:page ri:content-title="页面标题" />
		 * </ac:link>
		 * 转为: [[页面标题]]
		 */
		this.turndown.addRule("confluenceLink", {
			filter: (node: any) => {
				return (
					node.nodeName === "AC:LINK" ||
					node.nodeName === "AC-LINK"
				);
			},
			replacement: (content: string, node: any) => {
				// 尝试从子元素获取页面标题
				const pageRef = node.querySelector("ri\\:page, ri-page");
				if (pageRef) {
					const title = pageRef.getAttribute("ri:content-title") ||
					         pageRef.getAttribute("content-title");
					if (title) {
						return `[[${title}]]`;
					}
				}
				
				// 尝试从 ac:plain-text-link-body 获取
				const plainTextBody = node.querySelector("ac\\:plain-text-link-body, ac-plain-text-link-body");
				if (plainTextBody) {
					const title = plainTextBody.textContent?.trim();
					if (title) {
						return `[[${title}]]`;
					}
				}

				// 退回到内容或默认值
				return content ? `[[${content}]]` : "";
			},
		});

		// ==================== 2. 处理 Drawio 宏 ====================
		/**
		 * <ac:structured-macro ac:name="drawio"> 标签处理
		 */
		this.turndown.addRule("drawioMacro", {
			filter: (node: any) => {
				if (node.nodeName !== "AC:STRUCTURED-MACRO" && node.nodeName !== "AC-STRUCTURED-MACRO") {
					return false;
				}
				const macroName = node.getAttribute("ac:name") || node.getAttribute("name");
				return macroName === "drawio" || macroName === "gliffy";
			},
			replacement: (content: string, node: any) => {
				// 尝试获取图表名称
				const params = node.querySelectorAll("ac\\:parameter, ac-parameter");
				let diagramName = "图表";
				
				params.forEach((param: any) => {
					const paramName = param.getAttribute("ac:name") || param.getAttribute("name");
					if (paramName === "diagramName" || paramName === "name") {
						diagramName = param.textContent?.trim() || "图表";
					}
				});

				return `\n> 🖼️ **${diagramName}**: Drawio 图表（请手动查看 Confluence）\n`;
			},
		});

		// ==================== 3. 图片已在 sync-service.ts 中通过纯文本占位符处理 ====================
		// 不再使用 Turndown 规则处理图片，改为：
		// - 预处理：将 <ac:image> 替换为 %%CFLIMG0%% 占位符
		// - 后处理：在 Markdown 输出中将占位符替换为 ![[filename]]
		// 这样完全绕过 Turndown 的 DOM 解析和 isBlank 判定

		// ==================== 4. 处理信息面板宏 ====================
		/**
		 * <ac:structured-macro ac:name="info|warning|tip|note"> 标签处理
		 */
		this.turndown.addRule("panelMacro", {
			filter: (node: any) => {
				if (node.nodeName !== "AC:STRUCTURED-MACRO" && node.nodeName !== "AC-STRUCTURED-MACRO") {
					return false;
				}
				const macroName = node.getAttribute("ac:name") || node.getAttribute("name");
				return ["info", "warning", "tip", "note"].includes(macroName || "");
			},
			replacement: (content: string, node: any) => {
				const macroName = node.getAttribute("ac:name") || node.getAttribute("name");
				const richBody = node.querySelector("ac\\:rich-text-body, ac-rich-text-body");
				const bodyContent = richBody?.innerHTML || content;
				
				// 将宏名称转为表情符号
				const iconMap: Record<string, string> = {
					"info": "ℹ️",
					"warning": "⚠️",
					"tip": "💡",
					"note": "📝",
				};

				const icon = iconMap[macroName || ""] || "📌";
				const convertedBody = this.convert(bodyContent);

				return `\n> ${icon} **${macroName?.toUpperCase()}**\n> ${convertedBody.split('\n').join('\n> ')}\n`;
			},
		});

		// ==================== 6. 处理用户提及 ====================
		/**
		 * <ac:link> 包含 <ri:user> 处理
		 */
		this.turndown.addRule("userMention", {
			filter: (node: any) => {
				if (node.nodeName !== "AC:LINK" && node.nodeName !== "AC-LINK") {
					return false;
				}
				return !!node.querySelector("ri\\:user, ri-user");
			},
			replacement: (content: string, node: any) => {
				const userRef = node.querySelector("ri\\:user, ri-user");
				if (userRef) {
					const username = userRef.getAttribute("ri:username") ||
					            userRef.getAttribute("username");
					if (username) {
						return `@${username}`;
					}
				}
				return content || "";
			},
		});

		// ==================== 7. 清理 Confluence 特定标签 ====================
		/**
		 * 移除不需要的标签，但保留其内容
		 * 注意：图片和 Jira 宏已在 sync-service.ts 中通过字符串预处理转换为自定义标签
		 */
		this.turndown.addRule("unwrapConfluenceTags", {
			filter: function(node) {
				const nodeName = node.nodeName.toLowerCase();
				
				// 其他标签直接解包（小写匹配）
				const tagsToUnwrap = [
					"ac:rich-text-body",
					"ac:layout",
					"ac:layout-section",
					"ac:layout-cell",
					"ac:structured-macro", // 【核心修复】：防止未知容器宏（如折叠块）吞噬内部换行
					"ac-structured-macro",
					"ac:plain-text-body",
					"ac-plain-text-body"
				];
				return tagsToUnwrap.includes(nodeName);
			},
			replacement: (content: string) => {
				// 【核心修复】：强制添加块级换行，绝对防止段落被挤压成单行！
				return content ? `\n\n${content}\n\n` : "";
			},
		});

		// ==================== 8. 移除空段落 ====================
		this.turndown.addRule("removeEmptyParagraphs", {
			filter: (node: any) => {
				return (
					node.nodeName === "P" &&
					(!node.textContent || node.textContent.trim() === "")
				);
			},
			replacement: () => "",
		});
	}

	/**
	 * 将 HTML 转换为 Markdown
	 */
	convert(html: string): string {
		try {
			return this.turndown.turndown(html);
		} catch (error) {
			console.error("[Confluence Sync] HTML 转 Markdown 失败:", error);
			// 失败时返回清理后的原始文本
			return html.replace(/<[^>]*>/g, "");
		}
	}

	/**
	 * 生成带 YAML Frontmatter 的 Markdown 文档
	 */
	generateMarkdownWithFrontmatter(
		html: string,
		metadata: {
			title: string;
			pageId: string;
			version: number;
			confluenceUrl: string;
		}
	): string {
		// 转换正文
		const body = this.convert(html);

		// 构建 YAML Frontmatter
		const frontmatter = [
			"---",
			`title: "${metadata.title}"`,
			`confluence_page_id: "${metadata.pageId}"`,
			`version: ${metadata.version}`,
			`confluence_url: "${metadata.confluenceUrl}"`,
			`synced_at: "${new Date().toISOString()}"`,
			"---",
			"",
		].join("\n");

		return frontmatter + body;
	}
}
