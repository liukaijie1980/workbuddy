---
name: bocha-web-search
description: 联网搜索。当用户要查最新信息、新闻、网页、资料或明确要求搜索时使用。不要调用内置 web_search。
---

# 博查联网搜索

内置 `web_search` 没有可用的搜索服务。需要联网时，在仓库根目录执行：

```powershell
node scripts/bocha-search.mjs "搜索词"
```

工作目录是 `D:\GitHub\workbuddy`。脚本会读取本机 `.env.local` 里的 `BOCHA_API_KEY`，请求博查 Web Search，并打印标题、链接和摘要。

根据这些结果回答用户，并给出链接。不要把 API Key 写进回复。
