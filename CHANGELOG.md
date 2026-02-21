# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
