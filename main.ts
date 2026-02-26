/**
 * Confluence Sync Plugin - 主入口
 * 
 * 功能：从私有部署的 Confluence 单向同步页面到 Obsidian
 * 特点：
 * - 使用 CQL 查询获取指定根节点及其所有子节点
 * - 基于 ancestors 重构目录树，保持层级结构
 * - 支持增量同步（基于 lastModified 时间）
 * - 支持附件下载
 * - 使用 Turndown 转换 HTML 到 Markdown
 */
import { Plugin, Notice, TAbstractFile, TFile, addIcon } from "obsidian";
import {
	ConfluenceSyncSettings,
	DEFAULT_SETTINGS,
	ConfluenceSyncSettingTab,
} from "./src/settings";
import { SyncStateManager, PluginData, DEFAULT_PLUGIN_DATA } from "./src/sync-state";
import { ConfluenceApiClient } from "./src/confluence-api";
import { SyncService } from "./src/sync-service";

/**
 * 插件主类
 */
export default class ConfluenceSyncPlugin extends Plugin {
	settings: ConfluenceSyncSettings;
	private stateManager: SyncStateManager;
	private apiClient: ConfluenceApiClient;
	private syncService: SyncService;

	/**
	 * 插件加载
	 */
	async onload(): Promise<void> {
		console.log("[Confluence Sync] 插件加载中...");

		// 加载设置
		await this.loadSettings();

		// 初始化状态管理器
		await this.initializeStateManager();

		// 初始化 API 客户端
		this.initializeApiClient();

		// 初始化同步服务
		this.syncService = new SyncService(
			this.app,
			this.settings,
			this.apiClient,
			this.stateManager
		);

		// 添加设置面板
		this.addSettingTab(new ConfluenceSyncSettingTab(this.app, this));

		// 添加命令
		this.addCommands();

		// 添加侧边栏图标
		this.setupRibbonIcon();

		console.log("[Confluence Sync] 插件加载完成");
	}

	/**
	 * 插件卸载
	 */
	onunload(): void {
		console.log("[Confluence Sync] 插件已卸载");
	}

	/**
	 * 加载设置
	 */
	async loadSettings(): Promise<void> {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);
	}

	/**
	 * 保存设置
	 */
	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		// 更新同步服务的设置引用
		this.syncService?.updateSettings(this.settings);
		// 重新初始化 API 客户端（配置可能已变更）
		this.initializeApiClient();
	}

	/**
	 * 初始化状态管理器
	 */
	private async initializeStateManager(): Promise<void> {
		// 从 data.json 加载同步状态
		const savedData = await this.loadData();
		const pluginData: PluginData = {
			...DEFAULT_PLUGIN_DATA,
			...(savedData?.syncState ? { syncState: savedData.syncState } : {}),
			...(savedData?.lastGlobalSyncTime ? { lastGlobalSyncTime: savedData.lastGlobalSyncTime } : {}),
			...(savedData?.syncedRootIds ? { syncedRootIds: savedData.syncedRootIds } : {}),
		};

		this.stateManager = new SyncStateManager(pluginData, async () => {
			// 保存状态到 data.json
			const currentData = await this.loadData();
			await this.saveData({
				...currentData,
				...this.stateManager.getData(),
			});
		});
	}

	/**
	 * 初始化 API 客户端
	 */
	private initializeApiClient(): void {
		this.apiClient = new ConfluenceApiClient({
			baseUrl: this.settings.confluenceBaseUrl,
			username: this.settings.username,
			password: this.settings.password,
		});
	}

	/**
	 * 添加命令
	 */
	private addCommands(): void {
		// 手动同步命令
		this.addCommand({
			id: "sync-from-confluence",
			name: "从 Confluence 同步",
			callback: async () => {
				await this.syncFromConfluence();
			},
		});

		// 强制全量同步命令
		this.addCommand({
			id: "force-full-sync",
			name: "强制全量同步（忽略同步状态）",
			callback: async () => {
				const confirmed = confirm(
					"确定要执行全量同步吗？这将重新下载所有页面内容。"
				);
				if (confirmed) {
					await this.syncService.resetSyncState();
					new Notice("同步状态已重置，开始全量同步...");
					await this.syncFromConfluence();
				}
			},
		});

		// 查看同步统计
		this.addCommand({
			id: "show-sync-stats",
			name: "显示同步统计",
			callback: () => {
				const stats = this.syncService.getSyncStats();
				const lastSyncText = stats.lastSyncTime
					? new Date(stats.lastSyncTime).toLocaleString()
					: "从未";
				
				new Notice(
					`📊 同步统计\n已同步页面: ${stats.totalSyncedPages}\n上次同步: ${lastSyncText}`,
					10000
				);
			},
		});

		// 同步当前页面
		this.addCommand({
			id: "sync-current-page",
			name: "同步当前页面",
			checkCallback: (checking: boolean) => {
				const activeFile = this.app.workspace.getActiveFile();
				if (!activeFile) return false;
				const cache = this.app.metadataCache.getFileCache(activeFile);
				if (!cache?.frontmatter?.confluence_page_id) return false;
				if (!checking) {
					this.syncCurrentPage(false);
				}
				return true;
			},
		});

		// 强制同步当前页面（忽略版本号）
		this.addCommand({
			id: "force-sync-current-page",
			name: "强制同步当前页面（忽略版本）",
			checkCallback: (checking: boolean) => {
				const activeFile = this.app.workspace.getActiveFile();
				if (!activeFile) return false;
				const cache = this.app.metadataCache.getFileCache(activeFile);
				if (!cache?.frontmatter?.confluence_page_id) return false;
				if (!checking) {
					this.syncCurrentPage(true);
				}
				return true;
			},
		});

		// 推送当前页面到 Confluence（仅新建）
		this.addCommand({
			id: "push-to-confluence",
			name: "推送当前页面到 Confluence",
			checkCallback: (checking: boolean) => {
				const activeFile = this.app.workspace.getActiveFile();
				if (!activeFile || activeFile.extension !== "md") return false;
				// 已有 confluence_page_id 的不允许推送（防止覆盖）
				const cache = this.app.metadataCache.getFileCache(activeFile);
				if (cache?.frontmatter?.confluence_page_id) return false;
				if (!checking) {
					this.pushCurrentPage();
				}
				return true;
			},
		});
	}

	/**
	 * 初始化侧边栏图标
	 */
	private setupRibbonIcon(): void {
		// 添加同步图标到侧边栏
		this.addRibbonIcon(
			"refresh-cw",  // Obsidian 内置图标
			"从 Confluence 同步",
			async () => {
				await this.syncFromConfluence();
			}
		);
	}

	/**
	 * 执行同步（供外部调用）
	 */
	async syncFromConfluence(): Promise<void> {
		// 验证配置
		if (!this.validateSettings()) {
			return;
		}

		const notice = new Notice("🔄 正在从 Confluence 同步...", 0);

		try {
			const result = await this.syncService.pullFromConfluence();
			notice.hide();

			if (result.success) {
				const message = [
					"✅ 同步完成！",
					`新建: ${result.pagesCreated} 页`,
					`更新: ${result.pagesUpdated} 页`,
					`跳过: ${result.pagesSkipped} 页`,
					`附件: ${result.attachmentsDownloaded} 个`,
				].join("\n");
				new Notice(message, 5000);
			} else {
				const errorMsg = result.errors.join("; ").substring(0, 100);
				new Notice(`❌ 同步失败: ${errorMsg}...`, 5000);
			}
		} catch (error) {
			notice.hide();
			console.error("[Confluence Sync] 同步错误:", error);
			new Notice(`❌ 同步错误: ${error.message}`, 5000);
		}
	}

	/**
	 * 同步当前打开的页面
	 */
	async syncCurrentPage(force: boolean): Promise<void> {
		const activeFile = this.app.workspace.getActiveFile();
		if (!activeFile) {
			new Notice("❌ 没有打开的文件");
			return;
		}

		const cache = this.app.metadataCache.getFileCache(activeFile);
		const pageId = cache?.frontmatter?.confluence_page_id;
		if (!pageId) {
			new Notice("❌ 当前文件不是 Confluence 同步页面（缺少 confluence_page_id）");
			return;
		}

		if (!this.validateSettings()) return;

		const notice = new Notice(`🔄 正在同步页面「${activeFile.basename}」...`, 0);
		try {
			const result = await this.syncService.syncSinglePage(String(pageId), activeFile.path, force);
			notice.hide();
			if (result.success) {
				if (result.pagesSkipped > 0) {
					new Notice("✅ 页面已是最新版本，无需更新");
				} else {
					new Notice(`✅ 页面已更新（附件: ${result.attachmentsDownloaded} 个）`, 5000);
				}
			} else {
				new Notice(`❌ 同步失败: ${result.errors.join('; ')}`, 5000);
			}
		} catch (error) {
			notice.hide();
			new Notice(`❌ 同步错误: ${error.message}`, 5000);
		}
	}

	/**
	 * 推送当前页面到 Confluence（创建新页面）
	 */
	async pushCurrentPage(): Promise<void> {
		const activeFile = this.app.workspace.getActiveFile();
		if (!activeFile) {
			new Notice("❌ 没有打开的文件");
			return;
		}

		if (!this.validateSettingsForPush()) return;

		const cache = this.app.metadataCache.getFileCache(activeFile);
		const frontmatter = cache?.frontmatter;

		// 确认操作
		const confirmed = confirm(
			`确定要将「${activeFile.basename}」发布到 Confluence 吗？\n\n` +
			`Space: ${this.settings.spaceKey}\n` +
			`将创建为新页面，不会覆盖已有页面。`
		);
		if (!confirmed) return;

		const notice = new Notice(`📤 正在推送「${activeFile.basename}」到 Confluence...`, 0);
		try {
			const content = await this.app.vault.read(activeFile);
			const result = await this.syncService.pushToConfluence(
				activeFile.path,
				activeFile.basename,
				content,
				frontmatter
			);
			notice.hide();

			if (result.success) {
				// 在文件的 frontmatter 中写回 confluence_page_id
				await this.writeBackPageId(activeFile, result.pageId!, result.pageUrl!);
				new Notice(`✅ 已发布到 Confluence\n页面 ID: ${result.pageId}`, 8000);
			} else {
				new Notice(`❌ 推送失败: ${result.error}`, 5000);
			}
		} catch (error) {
			notice.hide();
			new Notice(`❌ 推送错误: ${error.message}`, 5000);
		}
	}

	/**
	 * 推送成功后回写 Confluence 信息到 frontmatter
	 */
	private async writeBackPageId(file: TFile, pageId: string, pageUrl: string): Promise<void> {
		try {
			let content = await this.app.vault.read(file);
			const hasFrontmatter = content.startsWith("---\n");

			if (hasFrontmatter) {
				// 在现有 frontmatter 中追加字段
				content = content.replace(
					/^---\n/,
					`---\nconfluence_page_id: "${pageId}"\nconfluence_url: "${pageUrl}"\n`
				);
			} else {
				// 创建新的 frontmatter
				content = `---\nconfluence_page_id: "${pageId}"\nconfluence_url: "${pageUrl}"\n---\n${content}`;
			}

			await this.app.vault.modify(file, content);
		} catch (error) {
			console.error("[Confluence Sync] 回写 frontmatter 失败:", error);
		}
	}

	/**
	 * 验证推送所需的设置
	 */
	private validateSettingsForPush(): boolean {
		if (!this.settings.confluenceBaseUrl) {
			new Notice("❌ 请在设置中配置 Confluence 地址");
			return false;
		}
		if (!this.settings.username || !this.settings.password) {
			new Notice("❌ 请在设置中配置用户名和密码");
			return false;
		}
		if (!this.settings.spaceKey) {
			new Notice("❌ 请在设置中配置 Space Key（推送需要）");
			return false;
		}
		if (!this.settings.rootPageIds.trim()) {
			new Notice("❌ 请在设置中配置根页面 ID（用于确定父页面）");
			return false;
		}
		return true;
	}

	/**
	 * 测试连接（供设置面板调用）
	 */
	async testConnection(): Promise<void> {
		if (!this.settings.confluenceBaseUrl) {
			throw new Error("请配置 Confluence 地址");
		}
		if (!this.settings.username || !this.settings.password) {
			throw new Error("请配置用户名和密码");
		}

		await this.apiClient.testConnection();
	}

	/**
	 * 重置同步状态（供设置面板调用）
	 */
	async resetSyncState(): Promise<void> {
		await this.syncService.resetSyncState();
	}

	/**
	 * 获取同步统计（供设置面板调用）
	 */
	getSyncStats(): {
		totalSyncedPages: number;
		lastSyncTime: number;
	} {
		return this.syncService.getSyncStats();
	}

	/**
	 * 验证设置是否完整
	 */
	private validateSettings(): boolean {
		if (!this.settings.confluenceBaseUrl) {
			new Notice("❌ 请在设置中配置 Confluence 地址");
			return false;
		}
		if (!this.settings.username || !this.settings.password) {
			new Notice("❌ 请在设置中配置用户名和密码");
			return false;
		}
		if (!this.settings.rootPageIds.trim()) {
			new Notice("❌ 请在设置中配置根页面 ID");
			return false;
		}
		return true;
	}
}
