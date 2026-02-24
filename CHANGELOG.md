# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
