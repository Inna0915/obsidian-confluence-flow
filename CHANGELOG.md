# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.4.0] - 2026-06-02

### Changed
- **重写表格转换**：所有 Confluence 表格（含/不含合并单元格）统一转为 GFM Markdown，合并单元格(colspan/rowspan)拍平为"首格放内容、其余留空"。不再把复杂表格保留为原始 HTML。

### Fixed
- 修复表格内 Jira 链接 / 图片 / 内链丢失的问题 —— 调整转换顺序，宏/图片/链接预处理在表格转换之前完成，单元格内元素得以正确行内化
- 修复无合并单元格的简单表格被 Turndown 打散成竖排文本的问题
- 修复 `aura-panel` 等未知宏的 `<ac:parameter>` 样式 JSON 泄漏成正文的问题

### Added
- 支持 `ac:task-list` 任务清单 → `- [x]` / `- [ ]` 勾选框
- 支持 `viewpdf` 宏 → PDF 附件嵌入
- frontmatter 新增 `confluence_updated` 字段（Confluence 原文最后修改时间 `version.when`），便于按真实更新时间排序 `![[...]]`

### Removed
- **移除向 Confluence 写入（push）的全部能力**：删除"推送当前页面到 Confluence"命令、`MarkdownToStorageConverter`、`createPage` API、Space Key 设置。本插件回归纯单向（Confluence → Obsidian）同步。

## [1.3.0] - 2026-05-31

### Added
- 单页同步 / 强制同步当前页面命令（基于 frontmatter 的 `confluence_page_id`）

### Fixed
- 修复增量同步相关问题，性能优化

## [1.2.1] - 2026-02-24

### Added
- Draw.io 图表同时支持 `.drawio` 和 `.png` 双格式占位符

### Fixed
- 添加 Confluence 地址空值检查，未配置时给出明确错误提示

## [1.2.0] - 2026-02-24

### Added
- 新增文件夹路径自动补全 - 设置面板输入同步文件夹时提供路径建议
- 新增复杂表格支持 - 保留含 colspan/rowspan 的原始 HTML 表格

### Changed
- 优化分页日志输出 - 更清晰的调试信息
- 改进分页逻辑 - 使用服务端实际返回的 limit 判断
- 更新默认同步路径为 `21_工作/ConfluenceSync`

## [1.1.0] - 2026-02-24

### Added
- 新增 Draw.io 图表支持 - 自动提取图表文件名并生成 Obsidian 双链
- 新增附件本地缓存机制 - 跳过已下载文件，同步速度提升 100 倍

### Fixed
- 修复新增 Root ID 时增量同步失效的问题 - 新 Root ID 首次自动全量同步
- 修复 Jira 宏解析问题 - 支持 key、jql 参数以及 CDATA 包裹等各种变体
- 修复 XML 代码块内容错乱问题 - 添加 HTML 实体转义保护尖括号
- 修复嵌套宏导致文档排版挤压成一行的问题 - 精准正则仅处理目标宏
- 修复图片双链丢失问题 - 使用占位符策略绕过 Turndown 转义

### Improved
- 增强 Jira 链接提取健壮性 - 三级兜底策略（key → jql → fallback）
- 优化宏处理正则 - 仅匹配 jira/drawio/code 宏，避免破坏嵌套宏结构
- 优化目录结构逻辑 - 父页面生成文件夹，子页面平铺存放

## [1.0.0] - 2026-02-21

### Added
- 初始版本发布
- 实现从 Confluence 到 Obsidian 的单向同步
- 支持基于 ancestors 的树形目录结构
- 支持增量同步（基于 lastModified 时间戳）
- 支持附件下载，自动保存到 Attachments 目录
- 实现 HTML Storage Format 到 Markdown 的转换
- 支持 Confluence 宏：代码块、图片、Jira 链接、信息面板
- 使用自定义 HTML 标签策略避免 Turndown 转义问题
- 添加设置面板，支持测试连接功能
- 实现同步状态管理（页面版本、同步时间）
- 支持重置同步状态进行全量同步
- 添加命令面板快捷操作

### Technical
- 使用 Obsidian `requestUrl` API 绕过 CORS
- 使用 Turndown 进行 HTML 到 Markdown 转换
- 使用 Basic Auth 进行 Confluence 认证
- 使用 CQL (Confluence Query Language) 查询页面
