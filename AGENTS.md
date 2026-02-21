# Confluence Sync - AI Agent 指南

## 项目概述

Confluence Sync 是一个 Obsidian 插件，用于从私有部署的 Confluence 服务器单向同步页面到 Obsidian。支持树形目录结构、增量同步和附件下载。

**主要功能特点：**
- 使用 CQL 查询获取指定根节点及其所有子节点
- 基于 ancestors 重构目录树，保持层级结构
- 支持增量同步（基于 lastModified 时间）
- 支持附件下载
- 使用 Turndown 转换 HTML 到 Markdown

## 技术栈

- **语言**: TypeScript 4.7.4
- **构建工具**: esbuild 0.17.3
- **运行时**: Obsidian 桌面应用（Electron）
- **依赖库**:
  - `turndown` - HTML 转 Markdown
  - `obsidian` - Obsidian API

## 项目结构

```
.
├── main.ts                 # 插件主入口，定义 ConfluenceSyncPlugin 类
├── manifest.json           # Obsidian 插件清单
├── package.json            # NPM 配置
├── tsconfig.json           # TypeScript 配置
├── esbuild.config.mjs      # 构建配置
├── version-bump.mjs        # 版本号自动更新脚本
├── versions.json           # 版本兼容性映射
├── data.json               # 插件数据存储（同步状态）
└── src/                    # 源代码目录
    ├── settings.ts         # 设置接口和设置面板 UI
    ├── sync-state.ts       # 同步状态管理器
    ├── confluence-api.ts   # Confluence REST API 客户端
    ├── sync-service.ts     # 同步业务逻辑主模块
    └── html-to-md.ts       # HTML 转 Markdown 转换器
```

## 模块职责

### main.ts
插件主类，负责：
- 插件生命周期管理（onload/onunload）
- 初始化设置、状态管理器、API 客户端、同步服务
- 注册命令（同步、强制全量同步、查看统计）
- 注册侧边栏图标
- 验证设置完整性

### src/settings.ts
- `ConfluenceSyncSettings` - 设置接口（服务器地址、认证信息、同步文件夹、根页面 ID）
- `ConfluenceSyncSettingTab` - 设置面板 UI，提供表单和测试连接按钮

### src/sync-state.ts
- `SyncStateManager` - 管理同步状态，包括页面版本、本地路径、最后同步时间
- 数据持久化到 `data.json`
- 支持增量同步判断（needsSync）

### src/confluence-api.ts
- `ConfluenceApiClient` - Confluence REST API 客户端
- 使用 Obsidian 的 `requestUrl` 绕过 CORS
- 支持 Basic Auth 认证
- 主要方法：
  - `testConnection()` - 测试连接
  - `fetchAllPagesByRootIds()` - CQL 查询获取页面
  - `getPage()` - 获取单页详情
  - `getAttachments()` / `downloadAttachment()` - 附件操作

### src/sync-service.ts
- `SyncService` - 同步业务逻辑核心
- 主要方法：
  - `pullFromConfluence()` - 主同步函数
  - `calculatePagePaths()` - 基于 ancestors 计算本地路径
  - `syncAttachments()` - 同步附件
- 预处理 HTML：处理图片、Jira 宏、代码块等特殊标签

### src/html-to-md.ts
- `HtmlToMarkdownConverter` - 使用 Turndown 转换 HTML
- 自定义规则处理 Confluence 特有标签：
  - `ac:link` → Obsidian 双链 `[[title]]`
  - `ac:structured-macro` (info/warning/tip/note) → 引用块
  - `ac:structured-macro` (drawio) → 占位提示
  - `ri:user` → `@username` 提及

## 构建命令

```bash
# 开发模式（监听文件变化，自动重新构建）
npm run dev

# 生产构建（包含类型检查）
npm run build

# 版本号更新（自动更新 manifest.json 和 versions.json）
npm run version
```

构建输出为 `main.js`，由 esbuild 打包生成。

## 开发约定

### 代码风格
- 使用 TypeScript 严格模式（strictNullChecks: true）
- 类和方法使用 JSDoc 注释说明功能
- 私有方法使用 `private` 修饰符
- 异步方法返回 `Promise<T>`

### 文件命名
- 源代码文件使用小写连字符命名（如 `sync-service.ts`）
- 类名使用 PascalCase（如 `SyncService`）
- 接口名使用 PascalCase（如 `ConfluencePage`）

### 错误处理
- 使用 try-catch 包裹异步操作
- 错误信息使用 `console.error` 输出，前缀为 `[Confluence Sync]`
- 用户-facing 的错误使用 Obsidian `Notice` 显示

### 路径处理
- 使用 Obsidian 的 `normalizePath` 处理文件路径
- 文件名使用 `sanitizeFileName` 清理非法字符（Windows: `\ / : * ? " < > |`）

## 配置说明

插件设置存储在 `data.json` 中，包含：

```typescript
interface ConfluenceSyncSettings {
    confluenceBaseUrl: string;  // 服务器地址
    username: string;           // 用户名
    password: string;           // 密码/API Token
    syncFolder: string;         // 同步目标文件夹
    rootPageIds: string;        // 根页面 ID 列表（逗号/换行分隔）
}
```

同步状态也存储在 `data.json` 中：

```typescript
interface PluginData {
    syncState: Record<string, PageSyncState>;  // 页面同步状态映射
    lastGlobalSyncTime: number;                // 上次全局同步时间戳
}
```

## 安全注意事项

1. **凭证存储**：用户名和密码以明文形式存储在 `data.json` 中（Obsidian 插件标准做法）
2. **Basic Auth**：使用 Base64 编码的 Basic Auth 头进行认证
3. **附件下载**：验证 URL 格式后再下载，防止非法路径
4. **CQL 注入**：用户输入的根页面 ID 会被严格过滤和验证

## 调试技巧

1. 在设置面板中点击"重置同步状态"可清除同步记录，下次执行全量同步
2. 使用命令面板（Ctrl+P）输入 "Confluence" 查看所有可用命令
3. 查看浏览器控制台（Ctrl+Shift+I）获取详细日志，日志前缀为 `[Confluence Sync]`
4. 检查 `data.json` 文件了解当前同步状态

## 发布流程

1. 更新 `package.json` 中的版本号
2. 运行 `npm run version` 自动更新 `manifest.json` 和 `versions.json`
3. 运行 `npm run build` 生成生产版本
4. 提交 `manifest.json`, `versions.json`, `main.js` 到 Git 仓库
5. 创建 GitHub Release，上传 `main.js` 和 `manifest.json`

## 依赖更新

```bash
# 检查更新
npm outdated

# 更新依赖
npm update

# 安装新依赖
npm install <package>
```

注意：`obsidian` 包应使用 `latest` 标签以匹配用户安装的 Obsidian 版本。
