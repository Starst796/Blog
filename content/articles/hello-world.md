---
title: 你好，世界
date: 2026-01-01
summary: 第一篇示例文章，用来演示 front matter 写法与 Markdown 排版能力。
tags: [随笔, 示例]
draft: false
---

这是一篇随仓库一起发布的示例文章。你可以直接在管理后台编辑它，或者删掉后
换成自己的内容。文件名即文章的 URL：本文件是 `hello-world.md`，
对应地址 `/articles/hello-world`。

## 正文支持什么

标准 Markdown 都可以用：**粗体**、*斜体*、`行内代码`、[链接](https://example.com)、
引用、列表、表格、脚注，以及带语法高亮的代码块。

### 代码块

```python
from dataclasses import dataclass


@dataclass(slots=True)
class Post:
    title: str
    tags: list[str]
```

### 表格

| front matter 字段 | 含义 |
| --- | --- |
| `date` | 发布日期，文章列表按它倒序排列 |
| `collection` | 文集名称；留空则归入「未归档」 |
| `draft` | 设为 `true` 时不出现在公开页面与订阅源中 |
| `sensitive` | 设为 `true` 时任何情况下都不对外输出，适合存放含凭据的笔记 |
| `cover` | 可选封面图，填 `/uploads/...` 或外链 |

### 提示块

!!! note "小提示"
    提示块使用 `admonition` 语法（`!!! note "标题"` + 四空格缩进），
    适合写注意事项、警告与补充说明。

## 中文标题的锚点

`##` 到 `####` 会自动生成目录（`toc`），并且锚点保留中文字符，
所以标题顺序调整后，已经分享出去的锚点依然有效。
