---
title: 示例项目
status: 进行中
period: 2026-01 ~ 至今
summary: 用一个示例项目演示项目卡片的字段、排序与链接排版。
stack: [Python, Flask, Markdown]
featured: true
order: 1
links:
  - { label: GitHub, url: "https://github.com/yourname/sample-project" }
  - { label: 在线预览, url: "https://example.com" }
---

文件名即项目的 URL：本文件是 `sample-project.md`，对应地址 `/projects/sample-project`。

## 字段说明

- `status`：显示在卡片右上角的状态标签，常用「进行中 / 已完成 / 已归档」。
- `period`：时间区间，纯文本，写 `2026-01 ~ 至今` 或 `2025.03 - 2025.09` 都行。
- `featured: true`：主页「近期项目」优先展示它；`order` 越小越靠前。
- `links`：列表形式，第一项会作为卡片的主动作按钮。

## 正文

正文里可以写项目背景、技术选型、遇到的坑与最终结果。
支持与文章完全相同的 Markdown 语法。
