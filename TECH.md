## 实现Skills搜索

使用skillsmp的api实现搜索功能

在 server 下，创建一个 config.ts 来保存 SKILLSMP_API_KEY

GET /api/v1/skills/ai-search
AI semantic search powered by Cloudflare AI

Parameter	Type	Required	Description
q	string	✓	AI search query

Code Examples

const response = await fetch(
  'https://skillsmp.com/api/v1/skills/ai-search?q=How+to+create+a+web+scraper',
  {
    headers: {
      'Authorization': 'Bearer sk_live_skillsmp_SNqsutoSiH51g-7-E0zVFVuugcnXfQbxCqfDI786TI0'
    }
  }
);

const data = await response.json();
console.log(data.data.skills);

Responses example:
{
    "success": true,
    "data": {
        "object": "vector_store.search_results.page",
        "search_query": "How to create a web scraper",
        "data": [
            {
                "file_id": "b941f4a570315d69f10272c602473c47f04bdd75fb714311ed36ea5b7029b1e5",
                "filename": "skills/mattb543-asheville-event-feed-claude-event-scraper-skill-md.md",
                "score": 0.58138084,
                "skill": {
                    "id": "mattb543-asheville-event-feed-claude-event-scraper-skill-md",
                    "name": "event-scraper",
                    "author": "MattB543",
                    "description": "Create new event scraping scripts for websites. Use when adding a new event source to the Asheville Event Feed. ALWAYS start by detecting the CMS/platform and trying known API endpoints first. Browser scraping is NOT supported (Vercel limitation). Handles API-based, HTML/JSON-LD, and hybrid patterns with comprehensive testing workflows.",
                    "githubUrl": "https://github.com/MattB543/asheville-event-feed/tree/main/claude/event-scraper",
                    "skillUrl": "https://skillsmp.com/skills/mattb543-asheville-event-feed-claude-event-scraper-skill-md",
                    "stars": 5,
                    "updatedAt": 1768598524
                }
            },
            {
                "file_id": "34e6c58d525232653f2adfdf8bc5abf9b50eb9128b5abe68a630d656ca9801c9",
                "filename": "skills/dvorkinguy-claude-skills-agents-skills-apify-scraper-builder-skill-md.md",
                "score": 0.5716883
            },
            {
                "file_id": "7dcf28e65a11cb6fb0e205bc9b3ad1ce9007724f809632ccd81f42c3167bd688",
                "filename": "skills/honeyspoon-nix-config-config-opencode-skill-web-scraper-skill-md.md",
                "score": 0.5999056,
                "skill": {
                    "id": "honeyspoon-nix-config-config-opencode-skill-web-scraper-skill-md",
                    "name": "web-scraper",
                    "author": "honeyspoon",
                    "description": "This skill should be used when users need to scrape content from websites, extract text from web pages, crawl and follow links, or download documentation from online sources. It features concurrent URL processing, automatic deduplication, content filtering, domain restrictions, and proper directory hierarchy based on URL structure. Use for documentation gathering, content extraction, web archival, or research data collection.",
                    "githubUrl": "https://github.com/honeyspoon/nix_config/tree/main/config/opencode/skill/web-scraper",
                    "skillUrl": "https://skillsmp.com/skills/honeyspoon-nix-config-config-opencode-skill-web-scraper-skill-md",
                    "stars": 0,
                    "updatedAt": 1769614394
                }
            },
            {
                "file_id": "1f2f1810d2d63396a79130bbb59849ad776fdcc6242e57120528d626d7da4adc",
                "filename": "skills/igosuki-claude-skills-web-scraper-skill-md.md",
                "score": 0.5999056,
                "skill": {
                    "id": "igosuki-claude-skills-web-scraper-skill-md",
                    "name": "web-scraper",
                    "author": "Igosuki",
                    "description": "This skill should be used when users need to scrape content from websites, extract text from web pages, crawl and follow links, or download documentation from online sources. It features concurrent URL processing, automatic deduplication, content filtering, domain restrictions, and proper directory hierarchy based on URL structure. Use for documentation gathering, content extraction, web archival, or research data collection.",
                    "githubUrl": "https://github.com/Igosuki/claude-skills/tree/main/web-scraper",
                    "skillUrl": "https://skillsmp.com/skills/igosuki-claude-skills-web-scraper-skill-md",
                    "stars": 1,
                    "updatedAt": 1761052646
                }
            },
            {
                "file_id": "8bc3072e2ca3c703aae8ec4cb48be2a3c0826d96b4f22585788d34f1ddd9cbda",
                "filename": "skills/breverdbidder-life-os-skills-website-to-vite-scraper-skill-md.md",
                "score": 0.5806182,
                "skill": {
                    "id": "breverdbidder-life-os-skills-website-to-vite-scraper-skill-md",
                    "name": "website-to-vite-scraper",
                    "author": "breverdbidder",
                    "description": "Multi-provider website scraper that converts any website (including CSR/SPA) to deployable static sites. Uses Playwright, Apify RAG Browser, Crawl4AI, and Firecrawl for comprehensive scraping. Triggers on requests to clone, reverse-engineer, or convert websites.",
                    "githubUrl": "https://github.com/breverdbidder/life-os/tree/main/skills/website-to-vite-scraper",
                    "skillUrl": "https://skillsmp.com/skills/breverdbidder-life-os-skills-website-to-vite-scraper-skill-md",
                    "stars": 2,
                    "updatedAt": 1769767370
                }
            },
            {
                "file_id": "8ed6e980ab048ac58d8c7d3bd3238fdc4cda3d25f17bc97b4dc4cfb2cf34cd35",
                "filename": "skills/leobrival-serum-plugins-official-plugins-crawler-skills-website-crawler-skill-md.md",
                "score": 0.5535727,
                "skill": {
                    "id": "leobrival-serum-plugins-official-plugins-crawler-skills-website-crawler-skill-md",
                    "name": "website-crawler",
                    "author": "leobrival",
                    "description": "High-performance web crawler for discovering and mapping website structure. Use when users ask to crawl a website, map site structure, discover pages, find all URLs on a site, analyze link relationships, or generate site reports. Supports sitemap discovery, checkpoint/resume, rate limiting, and HTML report generation.",
                    "githubUrl": "https://github.com/leobrival/serum-plugins-official/tree/main/plugins/crawler/skills/website-crawler",
                    "skillUrl": "https://skillsmp.com/skills/leobrival-serum-plugins-official-plugins-crawler-skills-website-crawler-skill-md",
                    "stars": 1,
                    "updatedAt": 1769437425
                }
            },
            {
                "file_id": "efa5af3ef929da6b1db4f194da6d639600db620612b508e425099947215f480a",
                "filename": "skills/hokupod-sitepanda-assets-skill-md.md",
                "score": 0.57184756,
                "skill": {
                    "id": "hokupod-sitepanda-assets-skill-md",
                    "name": "sitepanda",
                    "author": "hokupod",
                    "description": "Scrape websites with a headless browser and extract main readable content as Markdown. Use this skill when the user asks to retrieve, analyze, or summarize content from a URL or website.",
                    "githubUrl": "https://github.com/hokupod/sitepanda/tree/main/assets",
                    "skillUrl": "https://skillsmp.com/skills/hokupod-sitepanda-assets-skill-md",
                    "stars": 10,
                    "updatedAt": 1768397847
                }
            },
            {
                "file_id": "e74a45c1d4c2646144b1019bb8a4e52aa4352c52a1b35566234a68bf057c666a",
                "filename": "skills/vanman2024-ai-dev-marketplace-plugins-rag-pipeline-skills-web-scraping-tools-skill-md.md",
                "score": 0.55511314
            },
            {
                "file_id": "9b11ec7c719303b2999eaf4fa535a26ffcf718ea773f579e5e6b5b8d046cce12",
                "filename": "skills/nathanvale-side-quest-marketplace-plugins-scraper-toolkit-skills-playwright-scraper-skill-md.md",
                "score": 0.54990166,
                "skill": {
                    "id": "nathanvale-side-quest-marketplace-plugins-scraper-toolkit-skills-playwright-scraper-skill-md",
                    "name": "playwright-scraper",
                    "author": "nathanvale",
                    "description": "Production-proven Playwright web scraping patterns with selector-first approach and robust error handling.\nUse when users need to build web scrapers, extract data from websites, automate browser interactions,\nor ask about Playwright selectors, text extraction (innerText vs textContent), regex patterns for HTML,\nfallback hierarchies, or scraping best practices.",
                    "githubUrl": "https://github.com/nathanvale/side-quest-marketplace/tree/main/plugins/scraper-toolkit/skills/playwright-scraper",
                    "skillUrl": "https://skillsmp.com/skills/nathanvale-side-quest-marketplace-plugins-scraper-toolkit-skills-playwright-scraper-skill-md",
                    "stars": 2,
                    "updatedAt": 1769733906
                }
            },
            {
                "file_id": "42348180a6ffcff196f8aa2b23797a0868a891174655e0c4df3245b4bfc530a0",
                "filename": "skills/salberg87-authenticated-scrape-skill-md.md",
                "score": 0.5437498,
                "skill": {
                    "id": "salberg87-authenticated-scrape-skill-md",
                    "name": "authenticated-scrape",
                    "author": "Salberg87",
                    "description": "Scrape data from authenticated websites by capturing network requests with auth headers automatically. Use when the user wants to extract data from logged-in pages, private dashboards, or authenticated APIs.",
                    "githubUrl": "https://github.com/Salberg87/authenticated-scrape",
                    "skillUrl": "https://skillsmp.com/skills/salberg87-authenticated-scrape-skill-md",
                    "stars": 0,
                    "updatedAt": 1767684913
                }
            }
        ],
        "has_more": false,
        "next_page": null
    },
    "meta": {
        "requestId": "f841d8bc-3d77-4a00-9899-4df8b4e52c86",
        "responseTimeMs": 3327
    }
}

Error Handling
The API uses standard HTTP status codes and returns error details in JSON format.

Error Code	HTTP	Description
MISSING_API_KEY	401	API key not provided
INVALID_API_KEY	401	Invalid API key
MISSING_QUERY	400	Missing required query parameter
INTERNAL_ERROR	500	Internal server error
Error Response Example:

json

Copy
{
  "success": false,
  "error": {
    "code": "INVALID_API_KEY",
    "message": "The provided API key is invalid"
  }
}
