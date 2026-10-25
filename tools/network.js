const axios = require("axios");

function formatNetworkError(err, toolName) {
  const code = err.code || "";
  const msg = err.message || "";
  if (
    code === "ENOTFOUND" ||
    code === "EAI_AGAIN" ||
    code === "ENETUNREACH" ||
    code === "ECONNREFUSED" ||
    code === "ETIMEDOUT" ||
    code === "ECONNABORTED" ||
    /getaddrinfo|network|internet|offline|disconnected|unreachable/i.test(msg)
  ) {
    return {
      success: false,
      error: `No internet connection or host unreachable. Please verify your network connection and try again.`,
      technical_details: msg || code,
      code: "NO_INTERNET",
    };
  }
  return {
    success: false,
    error: `${toolName} failed: ${msg}`,
    code: `${toolName.toUpperCase().replace(/\s+/g, "_")}_FAILED`,
  };
}

const networkTools = [
  {
    name: "http_get",
    description: "Perform an HTTP GET request and return the response body, status code, and headers.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The URL to GET" },
        headers: { type: "object", description: "Optional HTTP headers to send", default: {} },
        timeout_ms: { type: "number", description: "Timeout in milliseconds (default: 10000)", default: 10000 },
      },
      required: ["url"],
    },
    handler: async ({ url, headers = {}, timeout_ms = 10000 }) => {
      try {
        const response = await axios.get(url, {
          headers,
          timeout: timeout_ms,
          validateStatus: () => true,
          maxContentLength: 10 * 1024 * 1024, // 10MB
        });
        return {
          success: true,
          data: {
            status: response.status,
            status_text: response.statusText,
            headers: response.headers,
            body: typeof response.data === "string" ? response.data : JSON.stringify(response.data),
            content_type: response.headers["content-type"] || null,
          }
        };
      } catch (err) {
        return formatNetworkError(err, "HTTP GET");
      }
    },
  },
  {
    name: "http_post",
    description: "Perform an HTTP POST request with a JSON body and return the response.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The URL to POST to" },
        body: { type: "object", description: "JSON body to send" },
        headers: { type: "object", description: "Optional HTTP headers", default: {} },
        timeout_ms: { type: "number", description: "Timeout in milliseconds (default: 10000)", default: 10000 },
      },
      required: ["url"],
    },
    handler: async ({ url, body = {}, headers = {}, timeout_ms = 10000 }) => {
      try {
        const response = await axios.post(url, body, {
          headers: { "Content-Type": "application/json", ...headers },
          timeout: timeout_ms,
          validateStatus: () => true,
        });
        return {
          success: true,
          data: {
            status: response.status,
            status_text: response.statusText,
            body: typeof response.data === "string" ? response.data : JSON.stringify(response.data),
          }
        };
      } catch (err) {
        return formatNetworkError(err, "HTTP POST");
      }
    },
  },
  {
    name: "web_search",
    description: "Search the web using DuckDuckGo and return a list of results with titles, URLs, and snippets. No API key needed.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query" },
        max_results: { type: "number", description: "Maximum results to return (default: 10)", default: 10 },
        timeout_ms: { type: "number", description: "Request timeout in milliseconds (default: 10000)", default: 10000 },
      },
      required: ["query"],
    },
    handler: async ({ query, max_results = 10, timeout_ms = 10000 }) => {
      try {
        const response = await axios.get("https://api.duckduckgo.com/", {
          params: { q: query, format: "json", no_redirect: 1, no_html: 1 },
          timeout: timeout_ms,
        });

        const data = response.data;
        const results = [];

        if (data.AbstractText) {
          results.push({
            title: data.Heading || query,
            url: data.AbstractURL || data.AbstractSource,
            snippet: data.AbstractText,
            source: "abstract",
          });
        }

        if (data.RelatedTopics) {
          for (const topic of data.RelatedTopics.slice(0, max_results)) {
            if (topic.Text && topic.FirstURL) {
              results.push({
                title: topic.Text.split(" - ")[0] || topic.Text,
                url: topic.FirstURL,
                snippet: topic.Text,
                source: "related",
              });
            }
          }
        }

        if (results.length === 0) {
          try {
            const htmlResp = await axios.get(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
              headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
              timeout: 10000,
            });
            const html = htmlResp.data;
            const linkRegex = /class="result__title"[^>]*>[\s\S]*?href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
            const snippetRegex = /class="result__snippet"[^>]*>([\s\S]*?)<\/[^>]+>/g;
            let linkMatch, snippetMatch;
            const links = [];
            while ((linkMatch = linkRegex.exec(html)) !== null && links.length < max_results) {
              links.push({ url: linkMatch[1], title: linkMatch[2].replace(/<[^>]+>/g, "").trim() });
            }
            const snippets = [];
            while ((snippetMatch = snippetRegex.exec(html)) !== null && snippets.length < max_results) {
              snippets.push(snippetMatch[1].replace(/<[^>]+>/g, "").trim());
            }
            for (let i = 0; i < links.length; i++) {
              results.push({ ...links[i], snippet: snippets[i] || "", source: "html" });
            }
          } catch {
            /* ignore scrape errors */
          }
        }

        return {
          success: true,
          data: {
            query,
            count: Math.min(results.length, max_results),
            results: results.slice(0, max_results),
          }
        };
      } catch (err) {
        return formatNetworkError(err, "Web Search");
      }
    },
  },
];

module.exports = networkTools;
