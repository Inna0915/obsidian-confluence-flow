/**
 * 同步业务逻辑模块
 * 提供 pullFromConfluence 主函数，处理树形结构同步
 */
import { App, TFile, normalizePath, Platform, Notice } from "obsidian";
import { ConfluenceApiClient, ConfluencePage, ConfluenceAncestor, Attachment } from "./confluence-api";
import { HtmlToMarkdownConverter } from "./html-to-md";
import { SyncStateManager, PageSyncState } from "./sync-state";
import { ConfluenceSyncSettings } from "./settings";

/**
 * 同步结果统计
 */
export interface SyncResult {
	success: boolean;
	pagesCreated: number;
	pagesUpdated: number;
	pagesSkipped: number;
	attachmentsDownloaded: number;
	errors: string[];
}

/**
 * 页面路径信息
 */
interface PagePathInfo {
	pageId: string;
	title: string;
	folderPath: string;  // 文件夹路径（相对于 Vault 根目录）
	filePath: string;    // 完整文件路径
}

/**
 * 同步服务
 */
export class SyncService {
	private app: App;
	private settings: ConfluenceSyncSettings;
	private apiClient: ConfluenceApiClient;
	private stateManager: SyncStateManager;
	private htmlConverter: HtmlToMarkdownConverter;

	constructor(
		app: App,
		settings: ConfluenceSyncSettings,
		apiClient: ConfluenceApiClient,
		stateManager: SyncStateManager
	) {
		this.app = app;
		this.settings = settings;
		this.apiClient = apiClient;
		this.stateManager = stateManager;
		this.htmlConverter = new HtmlToMarkdownConverter();
	}

	/**
	 * 更新设置（用于设置变更后刷新）
	 */
	updateSettings(settings: ConfluenceSyncSettings): void {
		this.settings = settings;
	}

	/**
	 * 从 Confluence 拉取页面（主函数）
	 */
	async pullFromConfluence(): Promise<SyncResult> {
		const result: SyncResult = {
			success: false,
			pagesCreated: 0,
			pagesUpdated: 0,
			pagesSkipped: 0,
			attachmentsDownloaded: 0,
			errors: [],
		};

		try {
			// 1. 获取用户配置的所有 Root IDs
			const allRootIds = this.parseRootPageIds(this.settings.rootPageIds);
			if (allRootIds.length === 0) {
				throw new Error("未配置根页面 ID，请在设置中输入要同步的页面 ID");
			}

			// 2. 确保同步文件夹和附件文件夹存在
			await this.ensureSyncFolders();

			// 3. 【关键修复】新老 Root ID 分流处理
			const syncedRootIds = this.stateManager.getSyncedRootIds();
			
			// 计算全新 ID 和已同步 ID
			const newRootIds = allRootIds.filter(id => !syncedRootIds.includes(id));
			const existingRootIds = allRootIds.filter(id => syncedRootIds.includes(id));
			
			if (newRootIds.length > 0) {
				console.log(`[Confluence Sync] 新增 Root IDs: ${newRootIds.join(', ')}`);
			}
			if (existingRootIds.length > 0) {
				console.log(`[Confluence Sync] 已同步 Root IDs: ${existingRootIds.join(', ')}`);
			}

			let pages: ConfluencePage[] = [];

			// 4. 对老的 ID，带上 lastSyncTime 进行增量查询
			if (existingRootIds.length > 0) {
				const lastSyncTime = this.stateManager.getLastGlobalSyncTime();
				const existingPages = await this.apiClient.fetchAllPagesByRootIds(existingRootIds, lastSyncTime);
				pages = pages.concat(existingPages);
				console.log(`[Confluence Sync] 增量查询返回 ${existingPages.length} 个页面`);
			}

			// 5. 对全新的 ID，不带 lastSyncTime，进行首次全量查询
			if (newRootIds.length > 0) {
				const newPages = await this.apiClient.fetchAllPagesByRootIds(newRootIds, 0);
				pages = pages.concat(newPages);
				console.log(`[Confluence Sync] 全量查询返回 ${newPages.length} 个页面`);
			}

			// 6. 去重处理（防止同一个页面在两棵树里有交集）
			const uniquePagesMap = new Map<string, ConfluencePage>();
			pages.forEach(p => uniquePagesMap.set(p.id, p));
			pages = Array.from(uniquePagesMap.values());

			if (pages.length === 0) {
				new Notice("没有需要同步的新内容");
				result.success = true;
				return result;
			}

			// 4. 计算每个页面的本地路径（基于 ancestors 重构目录树）
			const pathInfos = this.calculatePagePaths(pages);

			// 5. 并发同步页面（带进度反馈）
			const CONCURRENCY = 5;
			const total = pages.length;
			let completed = 0;
			const progressNotice = new Notice(`同步中 (0/${total})...`, 0);
			const pendingStates: Record<string, PageSyncState> = {};

			const syncOnePage = async (page: ConfluencePage) => {
				try {
					const pathInfo = pathInfos.get(page.id);
					if (!pathInfo) {
						result.errors.push(`页面 ${page.id} 路径计算失败`);
						return;
					}

					// 检查是否需要同步
					if (!this.stateManager.needsSync(page.id, page.version.number)) {
						result.pagesSkipped++;
						return;
					}

					// 创建文件夹结构
					await this.createFolderStructure(pathInfo.folderPath);

					// 下载附件（利用 children.attachment.size 跳过无附件页面）
					const attachmentSize = page.children?.attachment?.size ?? -1;
					let attachmentCount = 0;
					if (attachmentSize !== 0) {
						attachmentCount = await this.syncAttachments(page.id, page.title);
					}
					result.attachmentsDownloaded += attachmentCount;

					// 转换 HTML 为 Markdown（统一走 processPageToMarkdown，避免逻辑重复）
					const markdownContent = this.processPageToMarkdown(page);

					// 写入文件
					const isNewFile = !this.app.vault.getAbstractFileByPath(pathInfo.filePath);
					await this.writeFile(pathInfo.filePath, markdownContent);

					if (isNewFile) {
						result.pagesCreated++;
					} else {
						result.pagesUpdated++;
					}

					// 收集状态，稍后批量持久化
					pendingStates[page.id] = {
						pageId: page.id,
						localPath: pathInfo.filePath,
						version: page.version.number,
						lastUpdated: Date.now(),
					};

				} catch (pageError) {
					const errorMsg = `同步页面 ${page.id} (${page.title}) 失败: ${pageError.message}`;
					console.error(`[Confluence Sync] ${errorMsg}`);
					result.errors.push(errorMsg);
				} finally {
					completed++;
					progressNotice.setMessage(`同步中 (${completed}/${total})...`);
				}
			};

			// 并发池执行
			const queue = [...pages];
			const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
				while (queue.length > 0) {
					const page = queue.shift()!;
					await syncOnePage(page);
				}
			});
			await Promise.all(workers);
			progressNotice.hide();

			// 批量持久化所有状态
			if (Object.keys(pendingStates).length > 0) {
				await this.stateManager.updatePageStates(pendingStates);
			}

			// 7. 【关键】同步完成后，将新 Root ID 标记为已同步
			if (newRootIds.length > 0) {
				await this.stateManager.addSyncedRootIds(newRootIds);
				console.log(`[Confluence Sync] 已将 ${newRootIds.length} 个 Root ID 标记为已同步`);
			}
			
			// 8. 更新全局同步时间
			await this.stateManager.updateLastGlobalSyncTime();
			result.success = result.errors.length === 0;

		} catch (error) {
			result.errors.push(`同步失败: ${error.message}`);
			console.error("[Confluence Sync] 同步失败:", error);
		}

		return result;
	}

	/**
	 * 解析根页面 ID 列表
	 * 支持逗号、换行、空格分隔
	 */
	private parseRootPageIds(input: string): string[] {
		if (!input.trim()) {
			return [];
		}
		
		return input
			.split(/[，,\n\s]+/)  // 支持中文逗号、英文逗号、换行、空格
			.map(id => id.trim())
			.filter(id => id.length > 0);
	}

	/**
	 * 确保同步文件夹和附件文件夹存在
	 */
	private async ensureSyncFolders(): Promise<void> {
		const syncFolder = normalizePath(this.settings.syncFolder);
		const attachmentsFolder = normalizePath(`${syncFolder}/Attachments`);

		// 检查并创建同步根文件夹
		const syncFolderExists = this.app.vault.getAbstractFileByPath(syncFolder);
		if (!syncFolderExists) {
			await this.app.vault.createFolder(syncFolder);
		}

		// 检查并创建附件文件夹
		const attachmentsFolderExists = this.app.vault.getAbstractFileByPath(attachmentsFolder);
		if (!attachmentsFolderExists) {
			await this.app.vault.createFolder(attachmentsFolder);
		}
	}

	/**
	 * 基于 ancestors 计算每个页面的本地路径
	 * 只有"父页面"才生成同名文件夹，子页面直接放在基础路径下
	 */
	private calculatePagePaths(pages: ConfluencePage[]): Map<string, PagePathInfo> {
		const pathMap = new Map<string, PagePathInfo>();
		const rootIds = new Set(this.parseRootPageIds(this.settings.rootPageIds));

		// 1. 扫描出所有属于"父页面"的 ID
		const parentPageIds = new Set<string>();
		for (const page of pages) {
			for (const ancestor of page.ancestors) {
				parentPageIds.add(ancestor.id);
			}
		}

		for (const page of pages) {
			const pathSegments: string[] = [];
			for (const ancestor of page.ancestors) {
				if (rootIds.has(ancestor.id)) continue;
				pathSegments.push(this.sanitizeFileName(ancestor.title));
			}

			const basePath = pathSegments.length > 0
				? normalizePath(`${this.settings.syncFolder}/${pathSegments.join("/")}`)
				: normalizePath(this.settings.syncFolder);

			const safePageTitle = this.sanitizeFileName(page.title);
			let folderPath = "";
			let filePath = "";

			// 2. 智能判断：如果是父页面就建文件夹，否则直接放在 basePath 下
			if (parentPageIds.has(page.id)) {
				folderPath = normalizePath(`${basePath}/${safePageTitle}`);
				filePath = normalizePath(`${folderPath}/${safePageTitle}.md`);
			} else {
				folderPath = basePath;
				filePath = normalizePath(`${folderPath}/${safePageTitle}.md`);
			}

			pathMap.set(page.id, { pageId: page.id, title: page.title, folderPath, filePath });
		}
		return pathMap;
	}

	/**
	 * 创建文件夹结构
	 */
	private async createFolderStructure(folderPath: string): Promise<void> {
		// 检查文件夹是否已存在
		const exists = this.app.vault.getAbstractFileByPath(folderPath);
		if (exists) {
			return;
		}

		// 逐级创建文件夹
		const parts = folderPath.split("/");
		let currentPath = "";

		for (const part of parts) {
			currentPath = currentPath ? `${currentPath}/${part}` : part;
			
			const folderExists = this.app.vault.getAbstractFileByPath(currentPath);
			if (!folderExists) {
				try {
					await this.app.vault.createFolder(currentPath);
				} catch (error) {
					// 忽略文件夹已存在的错误
					if (!error.message?.includes("already exists")) {
						throw error;
					}
				}
			}
		}
	}

	/**
	 * 同步页面的附件
	 * @returns 下载的附件数量
	 */
	private async syncAttachments(pageId: string, pageTitle: string): Promise<number> {
		try {
			const attachments = await this.apiClient.getAttachments(pageId);
			if (attachments.length === 0) {
				return 0;
			}

			const attachmentsFolder = normalizePath(
				`${this.settings.syncFolder}/Attachments`
			);

			let downloadedCount = 0;

			for (const attachment of attachments) {
				try {
					const safePageTitle = this.sanitizeFileName(pageTitle);
					let safeFileName = this.sanitizeFileName(attachment.title);
					// 无后缀的附件视为 drawio 图表（常规附件都有扩展名）
					if (!safeFileName.includes('.')) {
						safeFileName += '.drawio';
					}
					const fileName = `${safePageTitle}_${safeFileName}`;
					const filePath = normalizePath(`${attachmentsFolder}/${fileName}`);

					// 页面版本已变更才会进入此方法，直接重新下载所有附件
					const buffer = await this.apiClient.downloadAttachment(
						pageId,
						attachment.title
					);

					const existingFile = this.app.vault.getAbstractFileByPath(filePath);
					if (existingFile instanceof TFile) {
						await this.app.vault.modifyBinary(existingFile, buffer);
					} else {
						await this.app.vault.createBinary(filePath, buffer);
					}

					downloadedCount++;
				} catch (attachmentError) {
					console.error(
						`[Confluence Sync] 下载附件 ${attachment.title} 失败:`,
						attachmentError
					);
				}
			}

			return downloadedCount;
		} catch (error) {
			console.error(`[Confluence Sync] 获取页面 ${pageId} 附件列表失败:`, error);
			return 0;
		}
	}

	/**
	 * 写入文件内容（创建或修改）
	 */
	private async writeFile(filePath: string, content: string): Promise<void> {
		const existingFile = this.app.vault.getAbstractFileByPath(filePath);

		if (existingFile instanceof TFile) {
			// 修改现有文件
			await this.app.vault.modify(existingFile, content);
		} else {
			// 创建新文件
			await this.app.vault.create(filePath, content);
		}
	}

	/**
	 * 清理文件名中的非法字符
	 * Windows 非法字符: < > : " / \ | ? *
	 * 以及 Obsidian 不建议的字符
	 */
	private sanitizeFileName(name: string): string {
		// 只替换 Windows/macOS 文件系统真正不允许的字符
		// 注意：严禁替换 . (点号)，以保留文件扩展名
		// Windows 非法字符: \ / : * ? " < > |
		let safe = name
			.replace(/[\\/:*?"<>|]/g, "_")  // 替换非法字符为下划线
			.replace(/^\s+/, "")            // 移除开头的空格
			.replace(/\s+$/, "")            // 移除结尾的空格
			.replace(/\s+/g, " ");          // 合并多个空格

		// 限制长度（Windows 最大路径限制）
		if (safe.length > 200) {
			safe = safe.substring(0, 200);
		}

		// 如果为空，使用默认名称
		if (!safe.trim()) {
			safe = "untitled";
		}

		return safe.trim();
	}

	/**
	 * 获取同步统计信息
	 */
	getSyncStats(): {
		totalSyncedPages: number;
		lastSyncTime: number;
	} {
		return {
			totalSyncedPages: this.stateManager.getAllSyncedPageIds().length,
			lastSyncTime: this.stateManager.getLastGlobalSyncTime(),
		};
	}

	/**
	 * 将 Confluence 页面转换为 Markdown
	 * 顺序：宏/图片/链接预处理 → 清理未知宏参数 → 表格转 GFM → Turndown → 还原占位符
	 * 注意：表格转换必须在宏/图片/链接预处理「之后」，这样单元格内的 jira/图片/内链
	 *       已变成占位符或行内 HTML，会被正确转换（修复旧版表格内元素丢失的 bug）。
	 */
	private processPageToMarkdown(page: ConfluencePage): string {
		const safePageTitle = this.sanitizeFileName(page.title);
		let htmlContent = page.body.storage.value;

		// 占位符集合
		const imagePlaceholders: Map<string, string> = new Map();
		let imgPlaceholderIdx = 0;
		const linkPlaceholders: Map<string, string> = new Map();
		let linkPlaceholderIdx = 0;
		const rawPlaceholders: Map<string, string> = new Map();
		let rawPlaceholderIdx = 0;

		// 1a. Confluence 页面内部链接 → [[标题]]
		htmlContent = htmlContent.replace(
			/<ac:link[^>]*>[\s\S]*?<ri:page[^>]*ri:content-title="([^"]+)"[^>]*\/?>[\s\S]*?<\/ac:link>/gi,
			(match, title) => {
				const placeholder = `%%CFLLNK${linkPlaceholderIdx++}%%`;
				linkPlaceholders.set(placeholder, `[[${title}]]`);
				return placeholder;
			}
		);

		// 1b. 附件引用链接 → ![[本地文件]]
		htmlContent = htmlContent.replace(
			/<ac:link[^>]*>[\s\S]*?<ri:attachment[^>]*ri:filename="([^"]+)"[^>]*\/>[\s\S]*?<\/ac:link>/gi,
			(match, filename) => {
				const localFileName = `${safePageTitle}_${this.sanitizeFileName(filename)}`;
				const placeholder = `%%CFLIMG${imgPlaceholderIdx++}%%`;
				imagePlaceholders.set(placeholder, localFileName);
				return placeholder;
			}
		);

		// 1c. view-file 宏
		htmlContent = htmlContent.replace(
			/<ac:structured-macro[^>]*ac:name="view-file"[^>]*>[\s\S]*?<ri:attachment[^>]*ri:filename="([^"]+)"[^>]*\/>[\s\S]*?<\/ac:structured-macro>/gi,
			(match, filename) => {
				const localFileName = `${safePageTitle}_${this.sanitizeFileName(filename)}`;
				const placeholder = `%%CFLIMG${imgPlaceholderIdx++}%%`;
				imagePlaceholders.set(placeholder, localFileName);
				return placeholder;
			}
		);

		// 1d. <ac:image> 图片
		htmlContent = htmlContent.replace(
			/<ac:image[^>]*>[\s\S]*?<ri:attachment[^>]*ri:filename="([^"]+)"[^>]*>[\s\S]*?<\/ac:image>/gi,
			(match, filename) => {
				const localFileName = `${safePageTitle}_${this.sanitizeFileName(filename)}`;
				const placeholder = `%%CFLIMG${imgPlaceholderIdx++}%%`;
				imagePlaceholders.set(placeholder, localFileName);
				return placeholder;
			}
		);

		// 1e. 任务清单 ac:task-list → - [x] / - [ ]（用 raw 占位符避免 Turndown 转义）
		htmlContent = htmlContent.replace(
			/<ac:task-list>([\s\S]*?)<\/ac:task-list>/gi,
			(match, inner) => {
				const items: string[] = [];
				inner.replace(/<ac:task>([\s\S]*?)<\/ac:task>/gi, (m: string, t: string) => {
					const done = /<ac:task-status>\s*complete\s*<\/ac:task-status>/i.test(t);
					const bodyMatch = t.match(/<ac:task-body>([\s\S]*?)<\/ac:task-body>/i);
					let body = bodyMatch ? bodyMatch[1] : '';
					body = body.replace(/<[^>]+>/g, '').replace(/&nbsp;/gi, ' ').trim();
					items.push(`- [${done ? 'x' : ' '}] ${body}`);
					return m;
				});
				if (items.length === 0) return '';
				const placeholder = `%%CFLRAW${rawPlaceholderIdx++}%%`;
				rawPlaceholders.set(placeholder, '\n' + items.join('\n') + '\n');
				return placeholder;
			}
		);

		// 2. 预处理特定宏：jira/drawio/code/markdown/viewpdf
		htmlContent = htmlContent.replace(
			/<(?:ac:)?structured-macro[^>]*?(?:ac:)?name=['"]?(jira|jiraissues|drawio|gliffy|code|markdown|confluence-markdown|viewpdf)['"]?[^>]*>([\s\S]*?)<\/(?:ac:)?structured-macro>/gi,
			(match, macroType, innerContent) => {
				const macroName = macroType.toLowerCase();

				if (macroName === 'jira' || macroName === 'jiraissues') {
					let issueKey = "";
					const keyMatch = innerContent.match(/(?:ac:)?name=['"]key['"][^>]*>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\//i);
					if (keyMatch) issueKey = keyMatch[1].trim();

					if (!issueKey) {
						const jqlMatch = innerContent.match(/(?:ac:)?name=['"]jql['"][^>]*>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\//i);
						if (jqlMatch && jqlMatch[1]) {
							const extMatch = jqlMatch[1].match(/(?:issuekey|key)\s*[=in]\s*["']?([A-Z0-9]+-\d+)["']?/i);
							if (extMatch) issueKey = extMatch[1].trim();
						}
					}
					if (!issueKey) {
						const fallback = innerContent.match(/[A-Z0-9]+-\d+/i);
						if (fallback) issueKey = fallback[0].toUpperCase();
					}

					if (issueKey) {
						issueKey = issueKey.replace(/[^A-Z0-9-]/gi, '');
						return `<a href="https://jira.ykeey.cn/browse/${issueKey}">${issueKey}</a>`;
					}
					return `[Jira 链接解析失败]`;
				}

				if (macroName === 'drawio' || macroName === 'gliffy') {
					const diagMatch = innerContent.match(/(?:ac:)?name=['"](?:diagramName|name)['"][^>]*>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\//i);
					if (diagMatch && diagMatch[1]) {
						let diagramName = diagMatch[1].trim();
						if (!diagramName.includes('.')) diagramName += '.drawio';
						const localFileName = `${safePageTitle}_${this.sanitizeFileName(diagramName)}`;
						const pngFileName = `${safePageTitle}_${this.sanitizeFileName(diagMatch[1].trim())}.png`;
						const p1 = `%%CFLIMG${imgPlaceholderIdx++}%%`;
						const p2 = `%%CFLIMG${imgPlaceholderIdx++}%%`;
						imagePlaceholders.set(p1, localFileName);
						imagePlaceholders.set(p2, pngFileName);
						return `${p1}\n${p2}`;
					}
					return '';
				}

				if (macroName === 'viewpdf') {
					const fnMatch = innerContent.match(/<ri:attachment[^>]*ri:filename="([^"]+)"/i);
					if (fnMatch) {
						const localFileName = `${safePageTitle}_${this.sanitizeFileName(fnMatch[1])}`;
						const placeholder = `%%CFLIMG${imgPlaceholderIdx++}%%`;
						imagePlaceholders.set(placeholder, localFileName);
						return placeholder;
					}
					return '';
				}

				if (macroName === 'code') {
					const langMatch = innerContent.match(/(?:ac:)?name=['"]language['"][^>]*>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\//i);
					const lang = langMatch ? langMatch[1].trim() : '';

					const bodyMatch = innerContent.match(/<(?:ac:)?plain-text-body[^>]*>([\s\S]*?)<\/(?:ac:)?plain-text-body>/i);
					let code = bodyMatch ? bodyMatch[1] : '';

					code = code.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, "$1");
					code = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

					return `\n<pre><code class="language-${lang}">${code}</code></pre>\n`;
				}

				if (macroName === 'markdown' || macroName === 'confluence-markdown') {
					const bodyMatch = innerContent.match(/<(?:ac:)?plain-text-body[^>]*>([\s\S]*?)<\/(?:ac:)?plain-text-body>/i);
					let md = bodyMatch ? bodyMatch[1] : '';
					md = md.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, "$1");
					const placeholder = `%%CFLRAW${rawPlaceholderIdx++}%%`;
					rawPlaceholders.set(placeholder, md);
					return placeholder;
				}

				return match;
			}
		);

		// 2b. 清理未知宏遗留的参数（aura-panel 等的样式 JSON），防止泄漏成正文
		htmlContent = htmlContent
			.replace(/<ac:parameter\b[^>]*\/>/gi, '')
			.replace(/<ac:parameter\b[\s\S]*?<\/ac:parameter>/gi, '');

		// 2c. 表格 → GFM Markdown（此时单元格内已是占位符/行内 HTML）
		const tableResult = this.htmlConverter.extractTablesToMarkdown(htmlContent);
		htmlContent = tableResult.html;
		const tablePlaceholders = tableResult.tables;

		// 3. Turndown 转换
		const confluenceUrl = `${this.settings.confluenceBaseUrl}/pages/viewpage.action?pageId=${page.id}`;

		// 提取创建人
		let creator = "";
		if (page.history?.createdBy) {
			const cb = page.history.createdBy;
			creator = cb.displayName && cb.username 
				? `${cb.displayName} (${cb.username})` 
				: (cb.displayName || cb.username || "");
		}

		// 提取修改人
		let modifier = "";
		if (page.version?.by) {
			const mb = page.version.by;
			modifier = mb.displayName && mb.username 
				? `${mb.displayName} (${mb.username})` 
				: (mb.displayName || mb.username || "");
		}

		let markdownContent = this.htmlConverter.generateMarkdownWithFrontmatter(
			htmlContent,
			{
				title: page.title,
				pageId: page.id,
				version: page.version.number,
				confluenceUrl,
				updatedAt: page.version.when,
				creator,
				modifier,
			}
		);

		// 4. 后处理：还原占位符。表格必须最先还原（其内部仍含图片/内链占位符）
		for (const [placeholder, tableMd] of tablePlaceholders) {
			markdownContent = markdownContent.replace(placeholder, () => tableMd);
		}
		for (const [placeholder, localFileName] of imagePlaceholders) {
			markdownContent = markdownContent.replace(placeholder, () => `![[${localFileName}]]`);
		}
		for (const [placeholder, rawMd] of rawPlaceholders) {
			markdownContent = markdownContent.replace(placeholder, () => rawMd);
		}
		for (const [placeholder, link] of linkPlaceholders) {
			markdownContent = markdownContent.replace(placeholder, () => link);
		}

		return markdownContent;
	}

	/**
	 * 同步单个页面（用于当前页面更新）
	 * @param pageId Confluence 页面 ID
	 * @param existingFilePath 现有文件路径
	 * @param force 是否强制更新（忽略版本检查）
	 */
	async syncSinglePage(pageId: string, existingFilePath: string, force: boolean = false): Promise<SyncResult> {
		const result: SyncResult = {
			success: false,
			pagesCreated: 0,
			pagesUpdated: 0,
			pagesSkipped: 0,
			attachmentsDownloaded: 0,
			errors: [],
		};

		try {
			// 1. 获取页面最新内容
			const page = await this.apiClient.getPage(pageId);

			// 2. 版本检查（非强制模式）
			if (!force && !this.stateManager.needsSync(pageId, page.version.number)) {
				result.pagesSkipped = 1;
				result.success = true;
				return result;
			}

			// 3. 确保附件文件夹存在
			await this.ensureSyncFolders();

			// 4. 同步附件
			const attachmentSize = page.children?.attachment?.size ?? -1;
			if (attachmentSize !== 0) {
				result.attachmentsDownloaded = await this.syncAttachments(page.id, page.title);
			}

			// 5. 转换页面内容为 Markdown
			const markdownContent = this.processPageToMarkdown(page);

			// 6. 写入文件
			await this.writeFile(existingFilePath, markdownContent);
			result.pagesUpdated = 1;

			// 7. 更新同步状态
			await this.stateManager.updatePageState(pageId, {
				pageId: page.id,
				localPath: existingFilePath,
				version: page.version.number,
				lastUpdated: Date.now(),
			});

			result.success = true;
		} catch (error) {
			result.errors.push(`同步页面 ${pageId} 失败: ${error.message}`);
			console.error(`[Confluence Sync] 单页同步失败:`, error);
		}

		return result;
	}

	/**
	 * 清空同步状态（用于重新全量同步）
	 */
	async resetSyncState(): Promise<void> {
		await this.stateManager.clearAllStates();
	}
}
