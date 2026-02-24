# Confluence Sync

从私有部署的 Confluence 服务器单向同步页面到 Obsidian，支持树形目录结构、增量同步和附件下载。

## 功能特性

- 🌲 **树形结构同步** - 基于 Confluence 的 ancestors 关系重构层级目录，智能判断父/子页面文件夹结构
- ⚡ **增量同步** - 基于 `lastModified` 时间戳，只同步变更内容；新 Root ID 首次自动全量同步
- 📎 **附件下载** - 自动下载页面附件，本地缓存跳过已下载文件，避免重复下载大文件
- 📋 **复杂表格** - 保留含合并单元格(colspan/rowspan)的原始 HTML 表格
- 🔄 **增量更新** - 记录同步状态，避免重复下载未变更页面
- 🏷️ **元数据保留** - 在 YAML Frontmatter 中保存 Confluence 页面 ID、版本号、同步时间等信息
- 🎨 **富媒体转换** - 支持代码块、图片、Jira 链接、Draw.io 图表、信息面板等 Confluence 宏转换为 Markdown

## 安装

### 从 Obsidian 社区插件市场

1. 打开 Obsidian → 设置 → 第三方插件
2. 关闭安全模式
3. 点击"浏览"搜索 "Confluence Sync"
4. 点击安装并启用

### 手动安装

1. 下载最新版本的 `main.js` 和 `manifest.json`
2. 复制到你的 Vault 目录 `.obsidian/plugins/confluence-sync/`
3. 重启 Obsidian 并在设置中启用插件

## 使用方法

### 1. 配置连接信息

打开设置面板，填写以下信息：

| 配置项 | 说明 | 示例 |
|--------|------|------|
| Confluence 地址 | 服务器基础 URL | `https://confluence.company.com` |
| 用户名 | 登录用户名 | `your-username` |
| 密码/API Token | 密码或个人访问令牌 | `your-password` |
| 同步文件夹 | Obsidian 中的目标文件夹 | `ConfluenceSync` |
| 根页面 ID | 要同步的页面 ID（支持多个） | `123456, 789012` |

### 2. 测试连接

点击"测试连接"按钮验证配置是否正确。

### 3. 执行同步

- **手动同步**: 点击"开始同步"按钮或命令面板中的 "Confluence Sync: 从 Confluence 同步"
- **强制全量同步**: 使用命令 "Confluence Sync: 强制全量同步" 忽略缓存重新下载所有内容

### 4. 增量更新

插件会自动记录上次同步时间，下次同步时只获取变更的页面。

## 目录结构

同步后的目录结构保持与 Confluence 一致：

```
ConfluenceSync/
├── 父页面A/
│   ├── 父页面A.md
│   └── 子页面B.md
└── 父页面C/
    ├── 父页面C.md
    └── Attachments/
        └── 图片1.png
```

- 每个页面生成独立的同名文件夹
- 子页面直接放在父页面目录下
- 附件统一存放在 `Attachments/` 目录

## 支持的 Confluence 宏

| Confluence 宏 | Markdown 输出 | 说明 |
|--------------|---------------|------|
| 代码块 | 围栏式代码块 ```language\ncode\n``` | 支持 XML/HTML 代码实体转义 |
| 图片 | Obsidian 双链 `![[filename.png]]` | 使用占位符策略避免 Turndown 转义问题 |
| 复杂表格 | 原始 HTML `<table>` | 保留 colspan/rowspan 合并单元格 |
| Jira 链接 | 外部链接 `[KEY](https://jira...)` | 支持 key/jql 参数、CDATA 包裹自动提取 |
| Draw.io 图表 | Obsidian 双链 `![[filename.drawio]]` | 自动提取图表文件名并关联附件 |
| 信息面板 | 引用块 `> **INFO** ...` | 支持 info/warning/tip/note |
| 双链 | 内部链接 `[[页面标题]]` | 保留 Confluence 页面引用关系 |

## 命令列表

打开命令面板（Ctrl/Cmd + P）搜索 "Confluence"：

- `Confluence Sync: 从 Confluence 同步` - 执行增量同步
- `Confluence Sync: 强制全量同步` - 清除缓存后全量同步
- `Confluence Sync: 显示同步统计` - 查看同步状态

## 配置说明

### 根页面 ID 格式

支持多种分隔符：

```
123456
123456, 789012
123456
789012
123456,789012,345678
```

### 增量同步原理

插件在 `data.json` 中记录：
- 每个页面的 Confluence 版本号
- 上次全局同步时间戳
- 页面本地路径映射

同步时通过 CQL 查询 `lastModified >= "timestamp"` 获取变更内容。

## 技术实现

- **API 请求**: 使用 Obsidian `requestUrl` 绕过 CORS
- **认证方式**: Basic Auth (Base64)
- **HTML 转换**: Turndown + 自定义规则处理 Confluence Storage Format
- **路径计算**: 基于 ancestors 数组智能构建目录树，父页面生成同名文件夹，子页面平铺存放
- **宏处理**: 精准正则预处理（仅处理 jira/drawio/code 宏），防止嵌套宏破坏 HTML 结构
- **附件优化**: 本地文件存在性检查，跳过已下载附件，速度提升 100 倍
- **增量策略**: 区分新老 Root ID，新 ID 首次全量同步，后续基于版本号增量更新

## 更新日志

### 最新改进（v1.2.1）

- ✅ **新增** Draw.io 双格式支持 - 同时生成 `.drawio` 和 `.png` 占位符
- ✅ **修复** 添加 Confluence 地址空值检查，未配置时给出明确错误提示
- ✅ 文件夹路径自动补全 - 设置面板输入路径时提供智能建议
- ✅ 复杂表格支持 - 保留含合并单元格的原始 HTML 表格
- ✅ 修复新增 Root ID 时增量同步失效的问题
- ✅ 修复 Jira 宏解析问题 - 支持 key、jql 参数以及 CDATA 包裹等各种变体
- ✅ 修复 XML 代码块内容错乱问题
- ✅ 修复嵌套宏导致文档排版挤压问题
- ✅ 新增 Draw.io 图表支持
- ✅ 附件下载优化 - 本地缓存机制跳过已下载文件

查看 [CHANGELOG.md](./CHANGELOG.md) 获取完整版本历史。

## 开发

```bash
# 克隆仓库
git clone https://github.com/Inna0915/obsidian-confluence-flow.git
cd obsidian-confluence-flow

# 安装依赖
npm install

# 开发模式（监听文件变化）
npm run dev

# 构建生产版本
npm run build
```

## 许可证

MIT License

## 支持

如有问题或建议，请在 [GitHub Issues](https://github.com/Inna0915/obsidian-confluence-flow/issues) 提交反馈。
