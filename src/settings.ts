/**
 * 配置模块 - 定义插件设置接口和设置面板
 */
import { App, PluginSettingTab, Setting, Notice } from "obsidian";
import ConfluenceSyncPlugin from "../main";
import { FolderSuggest } from "./utils/FolderSuggest";

/**
 * 插件设置接口
 */
export interface ConfluenceSyncSettings {
	// Confluence 服务器基础地址
	confluenceBaseUrl: string;
	// 用户名
	username: string;
	// 密码/API Token
	password: string;
	// 同步目标文件夹路径
	syncFolder: string;
	// 根页面 ID 列表（逗号或换行分隔）
	rootPageIds: string;
}

/**
 * 默认设置
 */
export const DEFAULT_SETTINGS: ConfluenceSyncSettings = {
	confluenceBaseUrl: "",
	username: "",
	password: "",
	syncFolder: "21_工作/ConfluenceSync",
	rootPageIds: "",
};

/**
 * 设置面板类
 */
export class ConfluenceSyncSettingTab extends PluginSettingTab {
	plugin: ConfluenceSyncPlugin;

	constructor(app: App, plugin: ConfluenceSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h2", { text: "Confluence Sync 设置" });

		// Confluence 基础地址设置
		new Setting(containerEl)
			.setName("Confluence 地址")
			.setDesc("您的 Confluence 服务器基础 URL，例如：https://confluence.company.com")
			.addText((text) =>
				text
					.setPlaceholder("https://confluence.company.com")
					.setValue(this.plugin.settings.confluenceBaseUrl)
					.onChange(async (value) => {
						this.plugin.settings.confluenceBaseUrl = value.trim();
						await this.plugin.saveSettings();
					})
			);

		// 用户名设置
		new Setting(containerEl)
			.setName("用户名")
			.setDesc("您的 Confluence 登录用户名")
			.addText((text) =>
				text
					.setPlaceholder("username")
					.setValue(this.plugin.settings.username)
					.onChange(async (value) => {
						this.plugin.settings.username = value.trim();
						await this.plugin.saveSettings();
					})
			);

		// 密码设置
		new Setting(containerEl)
			.setName("密码 / API Token")
			.setDesc("您的 Confluence 密码或 API Token")
			.addText((text) => {
				text.inputEl.type = "password";
				text
					.setPlaceholder("password")
					.setValue(this.plugin.settings.password)
					.onChange(async (value) => {
						this.plugin.settings.password = value;
						await this.plugin.saveSettings();
					});
			});

		// 同步文件夹设置
		new Setting(containerEl)
			.setName("同步文件夹")
			.setDesc("Confluence 页面同步到 Obsidian 的目标文件夹路径")
			.addText((text) => {
				text.setPlaceholder("输入或选择文件夹路径...");
				text.setValue(this.plugin.settings.syncFolder);
				new FolderSuggest(this.app, text.inputEl);
				text.onChange(async (value) => {
					this.plugin.settings.syncFolder = value.trim() || "21_工作/ConfluenceSync";
					await this.plugin.saveSettings();
				});
			});

		// 根页面 ID 列表设置
		new Setting(containerEl)
			.setName("根页面 ID 列表")
			.setDesc("输入要同步的根页面 ID，多个 ID 请用逗号或换行分隔")
			.addTextArea((text) => {
				text
					.setPlaceholder("123456789\n987654321")
					.setValue(this.plugin.settings.rootPageIds)
					.onChange(async (value) => {
						this.plugin.settings.rootPageIds = value;
						await this.plugin.saveSettings();
					});
				text.inputEl.rows = 5;
				text.inputEl.style.width = "100%";
			});

		// 测试连接按钮
		new Setting(containerEl)
			.setName("测试连接")
			.setDesc("验证 Confluence 连接配置是否正确")
			.addButton((button) => {
				button
					.setButtonText("测试连接")
					.setCta()
					.onClick(async () => {
						button.setDisabled(true);
						button.setButtonText("测试中...");
						try {
							await this.plugin.testConnection();
							new Notice("✅ Confluence 连接成功！");
						} catch (error) {
							new Notice(`❌ 连接失败: ${error.message}`);
						} finally {
							button.setDisabled(false);
							button.setButtonText("测试连接");
						}
					});
			});

		// 手动同步按钮
		new Setting(containerEl)
			.setName("手动同步")
			.setDesc("立即从 Confluence 拉取页面")
			.addButton((button) => {
				button
					.setButtonText("开始同步")
					.setCta()
					.onClick(async () => {
						button.setDisabled(true);
						button.setButtonText("同步中...");
						try {
							await this.plugin.syncFromConfluence();
							new Notice("✅ 同步完成！");
						} catch (error) {
							new Notice(`❌ 同步失败: ${error.message}`);
						} finally {
							button.setDisabled(false);
							button.setButtonText("开始同步");
						}
					});
			});

		// 添加调试区域
		containerEl.createEl("h3", { text: "调试工具", cls: "setting-item-heading" });

		// 重置同步状态按钮
		new Setting(containerEl)
			.setName("重置同步状态")
			.setDesc("清除同步时间和页面状态记录，下次同步将获取所有页面（用于调试）")
			.addButton((button) => {
				button
					.setButtonText("重置")
					.setWarning()  // 红色警告样式
					.onClick(async () => {
						const confirmed = confirm(
							"确定要重置同步状态吗？\n\n这将清除：\n• 上次同步时间\n• 所有页面的同步记录\n\n下次同步将重新获取所有页面。"
						);
						if (confirmed) {
							try {
								await this.plugin.resetSyncState();
								new Notice("✅ 同步状态已重置，下次将执行全量同步");
							} catch (error) {
								new Notice(`❌ 重置失败: ${error.message}`);
							}
						}
					});
			});

		// 显示当前同步统计
		const stats = this.plugin.getSyncStats();
		const lastSyncText = stats.lastSyncTime
			? new Date(stats.lastSyncTime).toLocaleString()
			: "从未";

		new Setting(containerEl)
			.setName("同步统计")
			.setDesc(`已同步页面: ${stats.totalSyncedPages} 页\n上次同步: ${lastSyncText}`)
			.addExtraButton((button) => {
				button
					.setIcon("refresh-cw")
					.setTooltip("刷新统计")
					.onClick(() => {
						this.display(); // 重新渲染设置面板
					});
			});
	}
}
