/**
 * Markdown → Confluence Storage Format 转换器
 * 将 Obsidian Markdown 转换为 Confluence 的 XHTML Storage Format
 * 
 * 注意：这是一个轻量转换器，主要用于新页面发布场景
 * 不处理 Confluence 特有宏的逆向转换（drawio 等）
 */

/**
 * Markdown 到 Confluence Storage Format 转换器
 */
export class MarkdownToStorageConverter {

	/**
	 * 将 Markdown 转换为 Confluence Storage Format
	 * @param markdown Markdown 内容（不含 YAML frontmatter）
	 */
	convert(markdown: string): string {
		// 0. 移除 YAML frontmatter（如果有的话）
		let content = markdown.replace(/^---\n[\s\S]*?\n---\n?/, "");

		// 1. 预处理：提取代码块防止内部被转换
		const codeBlocks: Map<string, string> = new Map();
		let codeIdx = 0;
		content = content.replace(/```(\w*)\n([\s\S]*?)```/g, (match, lang, code) => {
			const placeholder = `%%MDCODE${codeIdx++}%%`;
			const safeLang = this.escapeXml(lang || "");
			const safeCode = this.escapeXml(code.replace(/\n$/, "")); // 去掉尾部换行
			const storageBlock = `<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">${safeLang}</ac:parameter><ac:plain-text-body><![CDATA[${code.replace(/\n$/, "")}]]></ac:plain-text-body></ac:structured-macro>`;
			codeBlocks.set(placeholder, storageBlock);
			return placeholder;
		});

		// 2. 提取行内代码
		const inlineCodes: Map<string, string> = new Map();
		let inlineIdx = 0;
		content = content.replace(/`([^`\n]+)`/g, (match, code) => {
			const placeholder = `%%MDINL${inlineIdx++}%%`;
			inlineCodes.set(placeholder, `<code>${this.escapeXml(code)}</code>`);
			return placeholder;
		});

		// 3. 逐行 / 逐块转换
		const lines = content.split("\n");
		const result: string[] = [];
		let i = 0;

		while (i < lines.length) {
			const line = lines[i];

			// 空行
			if (line.trim() === "") {
				i++;
				continue;
			}

			// 标题 # ~ ######
			const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
			if (headingMatch) {
				const level = headingMatch[1].length;
				const text = this.convertInline(headingMatch[2]);
				result.push(`<h${level}>${text}</h${level}>`);
				i++;
				continue;
			}

			// 水平分割线
			if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
				result.push("<hr />");
				i++;
				continue;
			}

			// 引用块 >
			if (line.startsWith("> ") || line === ">") {
				const blockLines: string[] = [];
				while (i < lines.length && (lines[i].startsWith("> ") || lines[i] === ">")) {
					blockLines.push(lines[i].replace(/^>\s?/, ""));
					i++;
				}
				// 检测 Obsidian callout 语法 > [!type]
				const calloutMatch = blockLines[0]?.match(/^\[!(\w+)\]\s*(.*)?$/);
				if (calloutMatch) {
					const calloutType = calloutMatch[1].toLowerCase();
					const calloutTitle = calloutMatch[2] || "";
					const macroName = this.mapCalloutToMacro(calloutType);
					const bodyContent = blockLines.slice(1).join("\n");
					const bodyHtml = this.convertParagraphs(bodyContent);
					let titleParam = "";
					if (calloutTitle) {
						titleParam = `<ac:parameter ac:name="title">${this.escapeXml(calloutTitle)}</ac:parameter>`;
					}
					result.push(`<ac:structured-macro ac:name="${macroName}">${titleParam}<ac:rich-text-body>${bodyHtml}</ac:rich-text-body></ac:structured-macro>`);
				} else {
					const bodyHtml = this.convertParagraphs(blockLines.join("\n"));
					result.push(`<blockquote>${bodyHtml}</blockquote>`);
				}
				continue;
			}

			// 无序列表 - / * / +
			if (/^[\s]*[-*+]\s/.test(line)) {
				const listHtml = this.convertList(lines, i, "ul");
				result.push(listHtml.html);
				i = listHtml.nextIndex;
				continue;
			}

			// 有序列表 1.
			if (/^[\s]*\d+\.\s/.test(line)) {
				const listHtml = this.convertList(lines, i, "ol");
				result.push(listHtml.html);
				i = listHtml.nextIndex;
				continue;
			}

			// 表格
			if (line.includes("|") && i + 1 < lines.length && /^\|?\s*[-:]+/.test(lines[i + 1])) {
				const tableHtml = this.convertTable(lines, i);
				result.push(tableHtml.html);
				i = tableHtml.nextIndex;
				continue;
			}

			// 普通段落
			const paraLines: string[] = [];
			while (i < lines.length && lines[i].trim() !== "" && !lines[i].match(/^#{1,6}\s/) && !lines[i].startsWith("> ") && !/^[\s]*[-*+]\s/.test(lines[i]) && !/^[\s]*\d+\.\s/.test(lines[i]) && !/^(-{3,}|\*{3,}|_{3,})$/.test(lines[i].trim())) {
				paraLines.push(lines[i]);
				i++;
			}
			if (paraLines.length > 0) {
				const text = this.convertInline(paraLines.join("\n"));
				result.push(`<p>${text}</p>`);
			}
		}

		// 4. 还原代码块和行内代码
		let output = result.join("\n");
		for (const [placeholder, html] of codeBlocks) {
			output = output.replace(placeholder, html);
		}
		for (const [placeholder, html] of inlineCodes) {
			output = output.replace(placeholder, html);
		}

		return output;
	}

	/**
	 * 转换行内元素：加粗、斜体、链接、图片、删除线
	 */
	private convertInline(text: string): string {
		let result = text;

		// 图片 ![alt](url)
		result = result.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match, alt, url) => {
			return `<ac:image><ri:url ri:value="${this.escapeXml(url)}" /></ac:image>`;
		});

		// Obsidian 图片双链 ![[filename]]（转为纯文本提示）
		result = result.replace(/!\[\[([^\]]+)\]\]/g, (match, filename) => {
			return `<em>[附件: ${this.escapeXml(filename)}]</em>`;
		});

		// Obsidian 双链 [[title]] → Confluence 页面链接
		result = result.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (match, target, display) => {
			const title = display || target;
			return `<ac:link><ri:page ri:content-title="${this.escapeXml(target)}" /><ac:plain-text-link-body><![CDATA[${title}]]></ac:plain-text-link-body></ac:link>`;
		});

		// 链接 [text](url)
		result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, text, url) => {
			return `<a href="${this.escapeXml(url)}">${this.escapeXml(text)}</a>`;
		});

		// 粗斜体 ***text*** 或 ___text___
		result = result.replace(/\*{3}(.+?)\*{3}/g, "<strong><em>$1</em></strong>");
		result = result.replace(/_{3}(.+?)_{3}/g, "<strong><em>$1</em></strong>");

		// 粗体 **text** 或 __text__
		result = result.replace(/\*{2}(.+?)\*{2}/g, "<strong>$1</strong>");
		result = result.replace(/_{2}(.+?)_{2}/g, "<strong>$1</strong>");

		// 斜体 *text* 或 _text_
		result = result.replace(/\*(.+?)\*/g, "<em>$1</em>");
		result = result.replace(/_(.+?)_/g, "<em>$1</em>");

		// 删除线 ~~text~~
		result = result.replace(/~~(.+?)~~/g, "<del>$1</del>");

		return result;
	}

	/**
	 * 转换列表
	 */
	private convertList(lines: string[], startIndex: number, listType: "ul" | "ol"): { html: string; nextIndex: number } {
		const items: string[] = [];
		let i = startIndex;
		const pattern = listType === "ul" ? /^(\s*)[-*+]\s(.+)$/ : /^(\s*)\d+\.\s(.+)$/;

		while (i < lines.length) {
			const match = lines[i].match(pattern);
			if (!match) break;
			items.push(this.convertInline(match[2]));
			i++;
		}

		const listItems = items.map(item => `<li>${item}</li>`).join("");
		return { html: `<${listType}>${listItems}</${listType}>`, nextIndex: i };
	}

	/**
	 * 转换表格
	 */
	private convertTable(lines: string[], startIndex: number): { html: string; nextIndex: number } {
		let i = startIndex;
		const headerLine = lines[i];
		i++; // 跳过分隔行
		i++;

		// 解析表头
		const headers = this.parseTableRow(headerLine);
		let html = "<table><thead><tr>";
		for (const h of headers) {
			html += `<th>${this.convertInline(h)}</th>`;
		}
		html += "</tr></thead><tbody>";

		// 解析数据行
		while (i < lines.length && lines[i].includes("|")) {
			const cells = this.parseTableRow(lines[i]);
			html += "<tr>";
			for (const cell of cells) {
				html += `<td>${this.convertInline(cell)}</td>`;
			}
			html += "</tr>";
			i++;
		}

		html += "</tbody></table>";
		return { html, nextIndex: i };
	}

	/**
	 * 解析表格行
	 */
	private parseTableRow(line: string): string[] {
		return line.split("|")
			.map(cell => cell.trim())
			.filter((cell, index, arr) => {
				// 去掉首尾空 cell（行首行尾的 | 产生的）
				if (index === 0 && cell === "") return false;
				if (index === arr.length - 1 && cell === "") return false;
				return true;
			});
	}

	/**
	 * 批量转换段落文本
	 */
	private convertParagraphs(text: string): string {
		const paragraphs = text.split(/\n\n+/);
		return paragraphs.map(p => {
			const trimmed = p.trim();
			if (!trimmed) return "";
			return `<p>${this.convertInline(trimmed)}</p>`;
		}).filter(p => p).join("");
	}

	/**
	 * Callout 类型映射到 Confluence 宏名
	 */
	private mapCalloutToMacro(calloutType: string): string {
		const map: Record<string, string> = {
			"info": "info",
			"note": "note",
			"tip": "tip",
			"hint": "tip",
			"important": "warning",
			"warning": "warning",
			"caution": "warning",
			"danger": "warning",
			"bug": "warning",
			"example": "info",
			"quote": "info",
			"abstract": "info",
			"summary": "info",
			"tldr": "info",
			"success": "tip",
			"check": "tip",
			"done": "tip",
			"question": "note",
			"help": "note",
			"faq": "note",
			"failure": "warning",
			"fail": "warning",
			"missing": "warning",
		};
		return map[calloutType] || "info";
	}

	/**
	 * XML 特殊字符转义
	 */
	private escapeXml(text: string): string {
		return text
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;")
			.replace(/'/g, "&apos;");
	}
}
