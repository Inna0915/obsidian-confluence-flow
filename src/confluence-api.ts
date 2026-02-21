/**
 * Confluence API 客户端模块
 * 使用 Obsidian 的 requestUrl API 绕过 CORS，支持 Basic Auth 认证
 */
import { requestUrl, RequestUrlResponse, Notice } from "obsidian";

/**
 * Confluence 页面版本信息
 */
export interface ConfluenceVersion {
	number: number;
	when: string;
	message?: string;
}

/**
 * Confluence 父级页面信息（ancestors）
 */
export interface ConfluenceAncestor {
	id: string;
	type: string;
	status: string;
	title: string;
}

/**
 * Confluence 页面内容（body.storage）
 */
export interface ConfluenceBody {
	storage: {
		value: string;
		representation: "storage";
	};
}

/**
 * Confluence 页面对象
 */
export interface ConfluencePage {
	id: string;
	type: "page";
	status: "current" | "historical" | "trashed" | "draft";
	title: string;
	version: ConfluenceVersion;
	ancestors: ConfluenceAncestor[];
	body: ConfluenceBody;
	// 扩展字段
	children?: {
		attachment?: {
			size: number;
		};
	};
}

/**
 * CQL 查询结果
 */
export interface CQLSearchResult {
	results: ConfluencePage[];
	size: number;
	start: number;
	limit: number;
	_totalSize: number;
}

/**
 * 附件信息
 */
export interface Attachment {
	id: string;
	title: string;
	mediaType: string;
	size: number;
	downloadUrl: string;
}

/**
 * 附件列表结果
 */
export interface AttachmentListResult {
	results: Attachment[];
	size: number;
}

/**
 * Confluence API 客户端配置
 */
export interface ConfluenceApiConfig {
	baseUrl: string;
	username: string;
	password: string;
}

/**
 * Confluence API 客户端
 */
export class ConfluenceApiClient {
	private config: ConfluenceApiConfig;

	constructor(config: ConfluenceApiConfig) {
		this.config = config;
	}

	/**
	 * 清理基础 URL，去除末尾的斜杠
	 */
	private getCleanBaseUrl(): string {
		// 使用正则去除末尾的一个或多个斜杠
		return this.config.baseUrl.replace(/\/+$/, "");
	}

	/**
	 * 生成 Basic Auth 认证头
	 */
	private getAuthHeader(): string {
		const credentials = `${this.config.username}:${this.config.password}`;
		// 使用 btoa 进行 Base64 编码（Obsidian 环境支持）
		return `Basic ${btoa(credentials)}`;
	}

	/**
	 * 构建完整的 API URL
	 * 使用 URL 对象确保生成的网址是合法的
	 */
	private buildApiUrl(
		endpoint: string,
		params?: Record<string, string>
	): string {
		const baseUrl = this.getCleanBaseUrl();

		// 确保 endpoint 以 / 开头
		const cleanEndpoint = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;

		// 构建完整的 URL 字符串
		let urlString = `${baseUrl}${cleanEndpoint}`;

		// 如果有查询参数，追加到 URL
		if (params && Object.keys(params).length > 0) {
			const queryParts: string[] = [];
			for (const [key, value] of Object.entries(params)) {
				// 对参数名和参数值都进行严格的 URL 编码
				queryParts.push(
					`${encodeURIComponent(key)}=${encodeURIComponent(value)}`
				);
			}
			urlString += `?${queryParts.join("&")}`;
		}

		// 使用 URL 对象验证 URL 格式
		try {
			new URL(urlString);
		} catch (error) {
			throw new Error(`无效的 URL: ${urlString}`);
		}

		return urlString;
	}

	/**
	 * 发送 HTTP 请求
	 */
	private async request(
		url: string,
		method: "GET" | "POST" = "GET",
		body?: string
	): Promise<RequestUrlResponse> {
		const headers: Record<string, string> = {
			Authorization: this.getAuthHeader(),
			"Content-Type": "application/json",
			Accept: "application/json",
		};

		const response = await requestUrl({
			url,
			method,
			headers,
			body,
		});

		if (response.status >= 400) {
			console.error(`[Confluence Sync] HTTP ${response.status} Error:`, response.text);
			console.error(`[Confluence Sync] Request URL:`, url);
			throw new Error(`HTTP ${response.status}: ${response.text || '未知错误'}`);
		}

		return response;
	}

	/**
	 * 测试连接
	 * 验证 Confluence 地址、用户名和密码是否正确
	 */
	async testConnection(): Promise<boolean> {
		try {
			const baseUrl = this.getCleanBaseUrl();

			// 验证基础 URL 格式
			try {
				new URL(baseUrl);
			} catch {
				throw new Error(
					`Confluence 地址格式无效: ${baseUrl}，请检查是否包含协议（如 http:// 或 https://）`
				);
			}

			// 尝试获取当前用户信息来验证连接
			const url = this.buildApiUrl("/rest/api/user/current");
			await this.request(url);
			return true;
		} catch (error) {
			if (error.message?.includes("Invalid URL")) {
				throw new Error(
					`URL 格式错误: ${this.config.baseUrl}，请确保地址以 http:// 或 https:// 开头，且格式正确`
				);
			}
			if (error.message?.includes("401")) {
				throw new Error("认证失败，请检查用户名和密码");
			}
			if (error.message?.includes("404")) {
				throw new Error("Confluence API 未找到，请检查地址是否正确");
			}
			throw new Error(`连接失败: ${error.message}`);
		}
	}

	/**
	 * 使用 CQL 查询获取页面列表
	 *
	 * CQL 构造逻辑：
	 * - 基础查询：(id in (${rootIds}) OR ancestor in (${rootIds}))
	 * - 增量同步：追加 AND lastModified >= "${lastSyncTime}"
	 *
	 * @param rootIds 根页面 ID 列表
	 * @param lastSyncTime 上次同步时间戳（可选，用于增量同步）
	 * @param start 分页起始位置
	 * @param limit 每页数量
	 */
	async fetchPagesByRootIds(
		rootIds: string[],
		lastSyncTime?: number,
		start: number = 0,
		limit: number = 25
	): Promise<CQLSearchResult> {
		if (rootIds.length === 0) {
			return {
				results: [],
				size: 0,
				start: 0,
				limit,
				_totalSize: 0,
			};
		}

		// 构建 CQL 查询
		// 格式：(id in (123,456) OR ancestor in (123,456))
		const idList = rootIds.join(",");
		let cql = `(id in (${idList}) OR ancestor in (${idList}))`;

		// 如果是增量同步，添加时间条件
		if (lastSyncTime && lastSyncTime > 0) {
			// Confluence CQL 日期格式: yyyy-MM-dd HH:mm
			const date = new Date(lastSyncTime);
			const year = date.getFullYear();
			const month = String(date.getMonth() + 1).padStart(2, '0');
			const day = String(date.getDate()).padStart(2, '0');
			const hours = String(date.getHours()).padStart(2, '0');
			const minutes = String(date.getMinutes()).padStart(2, '0');
			const dateStr = `${year}-${month}-${day} ${hours}:${minutes}`;
			cql += ` AND lastModified >= "${dateStr}"`;
		}

		// 构建 URL：CQL 需要编码，但 expand 参数中的逗号不应被编码
		const baseUrl = this.getCleanBaseUrl();
		const encodedCql = encodeURIComponent(cql);
		// expand 参数不使用 encodeURIComponent，因为逗号需要保留
		const expand = "body.storage,version,ancestors";
		const url = `${baseUrl}/rest/api/content/search?cql=${encodedCql}&expand=${expand}&start=${start}&limit=${limit}`;

		console.log("[Confluence Sync] CQL:", cql);
		console.log("[Confluence Sync] Request URL:", url);

		const response = await this.request(url);
		return response.json as CQLSearchResult;
	}

	/**
	 * 获取单页详情
	 */
	async getPage(pageId: string): Promise<ConfluencePage> {
		const baseUrl = this.getCleanBaseUrl();
		const expand = "body.storage,version,ancestors,children.attachment";
		const url = `${baseUrl}/rest/api/content/${pageId}?expand=${expand}`;

		const response = await this.request(url);
		return response.json as ConfluencePage;
	}

	/**
	 * 获取页面的所有附件列表
	 */
	async getAttachments(pageId: string): Promise<Attachment[]> {
		const baseUrl = this.getCleanBaseUrl();
		const url = `${baseUrl}/rest/api/content/${pageId}/child/attachment?limit=100`;

		const response = await this.request(url);
		const result = response.json as AttachmentListResult;

		// 为每个附件构建下载 URL
		return result.results.map((att) => ({
			...att,
			downloadUrl: `${baseUrl}/download/attachments/${pageId}/${encodeURIComponent(att.title)}`,
		}));
	}

	/**
	 * 下载附件内容
	 * @param pageId 页面 ID
	 * @param attachmentName 附件名称
	 */
	async downloadAttachment(
		pageId: string,
		attachmentName: string
	): Promise<ArrayBuffer> {
		const baseUrl = this.getCleanBaseUrl();
		const encodedName = encodeURIComponent(attachmentName);
		const url = `${baseUrl}/download/attachments/${pageId}/${encodedName}`;

		// 验证 URL 格式
		try {
			new URL(url);
		} catch {
			throw new Error(`无效的附件下载 URL: ${url}`);
		}

		const response = await requestUrl({
			url,
			method: "GET",
			headers: {
				Authorization: this.getAuthHeader(),
			},
		});

		if (response.status >= 400) {
			throw new Error(`下载附件失败 HTTP ${response.status}: ${attachmentName}`);
		}

		return response.arrayBuffer;
	}

	/**
	 * 获取所有需要同步的页面（处理分页）
	 */
	async fetchAllPagesByRootIds(
		rootIds: string[],
		lastSyncTime?: number
	): Promise<ConfluencePage[]> {
		const allPages: ConfluencePage[] = [];
		let start = 0;
		const limit = 25;
		let hasMore = true;

		while (hasMore) {
			const result = await this.fetchPagesByRootIds(
				rootIds,
				lastSyncTime,
				start,
				limit
			);

			allPages.push(...result.results);

			// 检查是否还有更多数据
			hasMore = result.size === limit && allPages.length < result._totalSize;
			start += limit;

			// 安全限制：最多获取 1000 个页面
			if (allPages.length >= 1000) {
				console.warn("[Confluence Sync] 达到最大页面获取限制 (1000)");
				break;
			}
		}

		return allPages;
	}
}
