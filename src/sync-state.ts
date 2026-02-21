/**
 * 状态管理模块 - 管理同步状态和持久化数据
 */

/**
 * 单个页面的同步状态记录
 */
export interface PageSyncState {
	// Confluence 页面 ID
	pageId: string;
	// 本地文件路径
	localPath: string;
	// Confluence 页面版本号（用于判断是否需要更新）
	version: number;
	// 最后更新时间戳
	lastUpdated: number;
}

/**
 * 插件数据接口（存储在 data.json 中）
 */
export interface PluginData {
	// 同步状态映射表：pageId -> PageSyncState
	syncState: Record<string, PageSyncState>;
	// 上次全局同步时间戳（用于增量同步的 CQL 查询）
	lastGlobalSyncTime: number;
}

/**
 * 默认插件数据
 */
export const DEFAULT_PLUGIN_DATA: PluginData = {
	syncState: {},
	lastGlobalSyncTime: 0,
};

/**
 * 同步状态管理器
 */
export class SyncStateManager {
	private data: PluginData;
	private saveCallback: () => Promise<void>;

	constructor(initialData: PluginData, saveCallback: () => Promise<void>) {
		this.data = {
			...DEFAULT_PLUGIN_DATA,
			...initialData,
		};
		this.saveCallback = saveCallback;
	}

	/**
	 * 获取当前数据
	 */
	getData(): PluginData {
		return { ...this.data };
	}

	/**
	 * 获取指定页面的同步状态
	 */
	getPageState(pageId: string): PageSyncState | undefined {
		return this.data.syncState[pageId];
	}

	/**
	 * 更新页面同步状态
	 */
	async updatePageState(pageId: string, state: PageSyncState): Promise<void> {
		this.data.syncState[pageId] = state;
		await this.saveCallback();
	}

	/**
	 * 批量更新页面同步状态
	 */
	async updatePageStates(states: Record<string, PageSyncState>): Promise<void> {
		this.data.syncState = {
			...this.data.syncState,
			...states,
		};
		await this.saveCallback();
	}

	/**
	 * 删除页面同步状态
	 */
	async removePageState(pageId: string): Promise<void> {
		delete this.data.syncState[pageId];
		await this.saveCallback();
	}

	/**
	 * 获取上次全局同步时间
	 */
	getLastGlobalSyncTime(): number {
		return this.data.lastGlobalSyncTime;
	}

	/**
	 * 更新上次全局同步时间
	 */
	async updateLastGlobalSyncTime(timestamp: number = Date.now()): Promise<void> {
		this.data.lastGlobalSyncTime = timestamp;
		await this.saveCallback();
	}

	/**
	 * 检查页面是否需要同步
	 * @param pageId 页面 ID
	 * @param remoteVersion 远程版本号
	 */
	needsSync(pageId: string, remoteVersion: number): boolean {
		const state = this.getPageState(pageId);
		if (!state) {
			return true; // 新页面，需要同步
		}
		return remoteVersion > state.version; // 远程版本更新，需要同步
	}

	/**
	 * 获取所有已同步的页面 ID 列表
	 */
	getAllSyncedPageIds(): string[] {
		return Object.keys(this.data.syncState);
	}

	/**
	 * 清空所有同步状态（谨慎使用）
	 */
	async clearAllStates(): Promise<void> {
		this.data.syncState = {};
		this.data.lastGlobalSyncTime = 0;
		await this.saveCallback();
	}
}
