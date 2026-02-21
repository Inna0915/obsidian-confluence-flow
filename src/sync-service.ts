/**
 * 同步业务逻辑模块
 * 提供 pullFromConfluence 主函数，处理树形结构同步
 */
import { App, TFile, normalizePath, Platform, Notice } from "obsidian";
import { ConfluenceApiClient, ConfluencePage, ConfluenceAncestor } from "./confluence-api";
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
			// 1. 解析根页面 ID 列表
			const rootIds = this.parseRootPageIds(this.settings.rootPageIds);
			if (rootIds.length === 0) {
				throw new Error("未配置根页面 ID，请在设置中输入要同步的页面 ID");
			}

			// 2. 确保同步文件夹和附件文件夹存在
			await this.ensureSyncFolders();

			// 3. 获取需要同步的页面列表（CQL 查询）
			const lastSyncTime = this.stateManager.getLastGlobalSyncTime();
			const pages = await this.apiClient.fetchAllPagesByRootIds(rootIds, lastSyncTime);

			if (pages.length === 0) {
				new Notice("没有需要同步的新内容");
				result.success = true;
				return result;
			}

			// 4. 计算每个页面的本地路径（基于 ancestors 重构目录树）
			const pathInfos = this.calculatePagePaths(pages);

			// 5. 同步每个页面
			for (const page of pages) {
				try {
					const pathInfo = pathInfos.get(page.id);
					if (!pathInfo) {
						result.errors.push(`页面 ${page.id} 路径计算失败`);
						continue;
					}

					// 检查是否需要同步
					if (!this.stateManager.needsSync(page.id, page.version.number)) {
						result.pagesSkipped++;
						continue;
					}

					// 创建文件夹结构
					await this.createFolderStructure(pathInfo.folderPath);

					// 下载附件
					const attachmentCount = await this.syncAttachments(page.id, page.title);
					result.attachmentsDownloaded += attachmentCount;

					// ========== 字符串预处理（在调用 Turndown 之前）==========
					const safePageTitle = this.sanitizeFileName(page.title);
					let htmlContent = page.body.storage.value;

					// 1. 图片：使用纯文本占位符（完全绕过 Turndown DOM 解析）
					//    占位符仅含字母/数字/%/:，不会被 Turndown escape 转义
					const imagePlaceholders: Map<string, string> = new Map();
					let imgPlaceholderIdx = 0;
					htmlContent = htmlContent.replace(
						/<ac:image[^>]*>[\s\S]*?<ri:attachment[^>]*ri:filename="([^"]+)"[^>]*>[\s\S]*?<\/ac:image>/gi,
						(match, filename) => {
							const localFileName = `${safePageTitle}_${this.sanitizeFileName(filename)}`;
							const placeholder = `%%CFLIMG${imgPlaceholderIdx++}%%`;
							imagePlaceholders.set(placeholder, localFileName);
							console.log(`[Confluence Sync] 图片匹配成功: ${filename} → ${placeholder} → ![[${localFileName}]]`);
							return placeholder;
						}
					);
					// 调试：如果正则未命中，打印原始 HTML 中 ac:image 片段
					if (imagePlaceholders.size === 0) {
						const acImageSnippets = htmlContent.match(/<ac:image[\s\S]*?<\/ac:image>/gi);
						if (acImageSnippets) {
							console.warn(`[Confluence Sync] 页面 "${page.title}" 含 ${acImageSnippets.length} 个 <ac:image> 但正则未命中，原始片段:`);
							acImageSnippets.forEach((s, i) => console.warn(`  [${i}]`, s.substring(0, 300)));
						}
					}

					// 2. Jira：直接转换为标准 HTML 超链接 (Turndown 会原生处理)
					htmlContent = htmlContent.replace(
						/<ac:structured-macro[^>]*ac:name="jira"[^>]*>[\s\S]*?<ac:parameter[^>]*ac:name="key"[^>]*>([^<]+)<\/ac:parameter>[\s\S]*?<\/ac:structured-macro>/gi,
						(match, key) => `<a href="https://jira.ykeey.cn/browse/${key.trim()}">${key.trim()}</a>`
					);

					// 3. 预处理代码块：提取语言和 CDATA 中的代码，转换为标准 HTML
					htmlContent = htmlContent.replace(
						/<ac:structured-macro[^>]*ac:name="code"[^>]*>([\s\S]*?)<\/ac:structured-macro>/gi,
						(match, innerContent) => {
							// 提取语言 (容错：可能没有 language 参数)
							const langMatch = innerContent.match(/<ac:parameter[^>]*ac:name="language"[^>]*>([\s\S]*?)<\/ac:parameter>/i);
							const lang = langMatch ? langMatch[1].trim() : '';

							// 提取正文
							const bodyMatch = innerContent.match(/<ac:plain-text-body>([\s\S]*?)<\/ac:plain-text-body>/i);
							let code = bodyMatch ? bodyMatch[1] : '';

							// 剥离 CDATA 包装，保留原始换行
							code = code.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, "$1");
							
							// 转换为标准 HTML 代码块，Turndown 的默认规则会自动完美处理它
							return `\n<pre><code class="language-${lang}">${code}</code></pre>\n`;
						}
					);
					// =========================================================

					// 转换 HTML 为 Markdown
					const confluenceUrl = `${this.settings.confluenceBaseUrl}/pages/viewpage.action?pageId=${page.id}`;
					
					let markdownContent = this.htmlConverter.generateMarkdownWithFrontmatter(
						htmlContent,
						{
							title: page.title,
							pageId: page.id,
							version: page.version.number,
							confluenceUrl,
						}
					);

					// 后处理：将占位符替换为 Obsidian 图片双链
					for (const [placeholder, localFileName] of imagePlaceholders) {
						markdownContent = markdownContent.replace(placeholder, `![[${localFileName}]]`);
					}

					// 写入文件
					const isNewFile = !this.app.vault.getAbstractFileByPath(pathInfo.filePath);
					await this.writeFile(pathInfo.filePath, markdownContent);

					// 更新统计
					if (isNewFile) {
						result.pagesCreated++;
					} else {
						result.pagesUpdated++;
					}

					// 更新同步状态
					await this.stateManager.updatePageState(page.id, {
						pageId: page.id,
						localPath: pathInfo.filePath,
						version: page.version.number,
						lastUpdated: Date.now(),
					});

				} catch (pageError) {
					const errorMsg = `同步页面 ${page.id} (${page.title}) 失败: ${pageError.message}`;
					console.error(`[Confluence Sync] ${errorMsg}`);
					result.errors.push(errorMsg);
				}
			}

			// 6. 更新全局同步时间
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
					// 下载附件内容
					const buffer = await this.apiClient.downloadAttachment(
						pageId,
						attachment.title
					);

					// 处理文件名冲突（添加页面标题前缀）
					const safePageTitle = this.sanitizeFileName(pageTitle);
					const safeFileName = this.sanitizeFileName(attachment.title);
					const fileName = `${safePageTitle}_${safeFileName}`;
					const filePath = normalizePath(`${attachmentsFolder}/${fileName}`);

					// 保存附件
					const existingFile = this.app.vault.getAbstractFileByPath(filePath);
					if (existingFile instanceof TFile) {
						// 更新现有文件
						await this.app.vault.modifyBinary(existingFile, buffer);
					} else {
						// 创建新文件
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
	 * 清空同步状态（用于重新全量同步）
	 */
	async resetSyncState(): Promise<void> {
		await this.stateManager.clearAllStates();
	}
}
