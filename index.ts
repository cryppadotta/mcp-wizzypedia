#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import fetch from "node-fetch";
import { parseArgs } from "node:util";

// Parse command line arguments
const { values } = parseArgs({
  options: {
    "api-url": { type: "string" },
    "username": { type: "string" },
    "password": { type: "string" },
  },
});

// Get MediaWiki API credentials from command line or environment variables
const API_URL = values["api-url"] || process.env.MEDIAWIKI_API_URL;
const USERNAME = values["username"] || process.env.MEDIAWIKI_USERNAME;
const PASSWORD = values["password"] || process.env.MEDIAWIKI_PASSWORD;

if (!API_URL) {
  console.error("MediaWiki API URL is required. Set it via --api-url or MEDIAWIKI_API_URL");
  process.exit(1);
}

// MediaWiki API client
class MediaWikiClient {
  private apiUrl: string;
  private username?: string;
  private password?: string;
  private loggedIn = false;
  private editToken?: string;
  private cookies: string[] = [];

  constructor(apiUrl: string, username?: string, password?: string) {
    this.apiUrl = apiUrl;
    this.username = username;
    this.password = password;
  }

  private async makeApiCall(params: Record<string, any>, method: 'GET' | 'POST' = 'GET'): Promise<any> {
    const url = new URL(this.apiUrl);
    
    // Set common parameters
    params.format = 'json';
    params.formatversion = '2';
    
    const headers: Record<string, string> = {
      'User-Agent': 'MediaWiki-MCP-Server/1.0',
    };

    if (this.cookies.length > 0) {
      headers['Cookie'] = this.cookies.join('; ');
    }

    let response;
    if (method === 'GET') {
      // Append params to URL for GET requests
      Object.entries(params).forEach(([key, value]) => {
        if (value !== undefined) {
          url.searchParams.append(key, String(value));
        }
      });
      
      response = await fetch(url.toString(), { headers, method: 'GET' });
    } else {
      // Create form data for POST requests
      const formData = new URLSearchParams();
      Object.entries(params).forEach(([key, value]) => {
        if (value !== undefined) {
          formData.append(key, String(value));
        }
      });
      
      response = await fetch(url.toString(), {
        method: 'POST',
        headers: {
          ...headers,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: formData,
      });
    }

    // Save cookies from response
    const setCookieHeader = response.headers.get('Set-Cookie');
    if (setCookieHeader) {
      this.cookies.push(setCookieHeader);
    }

    const data = await response.json();
    if (data.error) {
      throw new Error(`MediaWiki API error: ${data.error.code} - ${data.error.info}`);
    }
    
    return data;
  }

  async login(): Promise<boolean> {
    if (!this.username || !this.password) {
      // No credentials provided, skip login
      return false;
    }

    if (this.loggedIn) {
      return true;
    }

    // Step 1: Get login token
    const tokenResponse = await this.makeApiCall({
      action: 'query',
      meta: 'tokens',
      type: 'login'
    });

    const loginToken = tokenResponse.query.tokens.logintoken;

    // Step 2: Perform login with token
    const loginResponse = await this.makeApiCall({
      action: 'login',
      lgname: this.username,
      lgpassword: this.password,
      lgtoken: loginToken
    }, 'POST');

    if (loginResponse.login.result === 'Success') {
      this.loggedIn = true;
      return true;
    } else {
      throw new Error(`Login failed: ${loginResponse.login.reason}`);
    }
  }

  async getEditToken(): Promise<string> {
    if (!this.editToken) {
      const tokenResponse = await this.makeApiCall({
        action: 'query',
        meta: 'tokens'
      });
      
      this.editToken = tokenResponse.query.tokens.csrftoken;
    }
    
    return this.editToken;
  }

  async searchPages(query: string, limit: number = 10): Promise<any> {
    return this.makeApiCall({
      action: 'query',
      list: 'search',
      srsearch: query,
      srlimit: limit,
      srinfo: 'totalhits',
      srprop: 'size|wordcount|timestamp|snippet'
    });
  }

  async getPage(title: string): Promise<any> {
    return this.makeApiCall({
      action: 'query',
      prop: 'revisions',
      titles: title,
      rvprop: 'content|timestamp|user|comment',
      rvslots: 'main'
    });
  }

  async createPage(title: string, content: string, summary: string = ''): Promise<any> {
    // Ensure we have an edit token
    const token = await this.getEditToken();
    
    return this.makeApiCall({
      action: 'edit',
      title,
      text: content,
      summary,
      token,
      createonly: true
    }, 'POST');
  }

  async updatePage(title: string, content: string, summary: string = ''): Promise<any> {
    // Ensure we have an edit token
    const token = await this.getEditToken();
    
    return this.makeApiCall({
      action: 'edit',
      title,
      text: content,
      summary,
      token
    }, 'POST');
  }

  async getPageHistory(title: string, limit: number = 10): Promise<any> {
    return this.makeApiCall({
      action: 'query',
      prop: 'revisions',
      titles: title,
      rvprop: 'timestamp|user|comment|ids',
      rvlimit: limit
    });
  }

  async getCategories(title: string): Promise<any> {
    return this.makeApiCall({
      action: 'query',
      prop: 'categories',
      titles: title,
      cllimit: 'max'
    });
  }
}

// Initialize the MediaWiki client
const wikiClient = new MediaWikiClient(API_URL, USERNAME, PASSWORD);

// Tool definitions
const SEARCH_PAGES_TOOL: Tool = {
  name: "search_pages",
  description: "Search for pages in the wiki using keywords",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Search query string"
      },
      limit: {
        type: "number",
        description: "Maximum number of results to return (default: 10, max: 50)",
        default: 10
      }
    },
    required: ["query"]
  }
};

const READ_PAGE_TOOL: Tool = {
  name: "read_page",
  description: "Fetch the raw wikitext content of a page",
  inputSchema: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description: "Title of the page to read"
      }
    },
    required: ["title"]
  }
};

const CREATE_PAGE_TOOL: Tool = {
  name: "create_page",
  description: "Create a new wiki page",
  inputSchema: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description: "Title of the new page"
      },
      content: {
        type: "string",
        description: "Wiki content for the new page"
      },
      summary: {
        type: "string",
        description: "Edit summary",
        default: "Created via MCP"
      }
    },
    required: ["title", "content"]
  }
};

const UPDATE_PAGE_TOOL: Tool = {
  name: "update_page",
  description: "Update an existing wiki page",
  inputSchema: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description: "Title of the page to update"
      },
      content: {
        type: "string",
        description: "New wiki content for the page"
      },
      summary: {
        type: "string",
        description: "Edit summary",
        default: "Updated via MCP"
      }
    },
    required: ["title", "content"]
  }
};

const GET_PAGE_HISTORY_TOOL: Tool = {
  name: "get_page_history",
  description: "Get revision history of a page",
  inputSchema: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description: "Title of the page"
      },
      limit: {
        type: "number",
        description: "Maximum number of revisions to return (default: 10)",
        default: 10
      }
    },
    required: ["title"]
  }
};

const GET_CATEGORIES_TOOL: Tool = {
  name: "get_categories",
  description: "Get categories a page belongs to",
  inputSchema: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description: "Title of the page"
      }
    },
    required: ["title"]
  }
};

// Create and configure the MCP server
const server = new Server(
  {
    name: "mediawiki-mcp-server",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Register the tools
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    SEARCH_PAGES_TOOL,
    READ_PAGE_TOOL,
    CREATE_PAGE_TOOL,
    UPDATE_PAGE_TOOL,
    GET_PAGE_HISTORY_TOOL,
    GET_CATEGORIES_TOOL
  ],
}));

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    if (!request.params.arguments) {
      throw new Error("Arguments are required");
    }

    // Ensure we're logged in for operations that might need it
    if (request.params.name !== "search_pages" && request.params.name !== "read_page") {
      await wikiClient.login();
    }

    switch (request.params.name) {
      case "search_pages": {
        const { query, limit = 10 } = request.params.arguments as { query: string; limit?: number };
        const result = await wikiClient.searchPages(query, Math.min(limit, 50));
        
        // Format search results in a readable way
        const pages = result.query.search.map((page: any) => ({
          title: page.title,
          snippet: page.snippet,
          size: page.size,
          wordCount: page.wordcount,
          timestamp: page.timestamp
        }));
        
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ 
              totalHits: result.query.searchinfo.totalhits,
              pages 
            }, null, 2)
          }]
        };
      }

      case "read_page": {
        const { title } = request.params.arguments as { title: string };
        const result = await wikiClient.getPage(title);
        
        const pages = result.query.pages;
        const page = pages[0];
        
        if (page.missing) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({ 
                title: page.title,
                exists: false,
                message: "Page does not exist"
              }, null, 2)
            }]
          };
        }
        
        const revision = page.revisions[0];
        const content = revision.slots.main.content;
        
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ 
              title: page.title,
              content: content,
              lastEdit: {
                timestamp: revision.timestamp,
                user: revision.user,
                comment: revision.comment
              }
            }, null, 2)
          }]
        };
      }

      case "create_page": {
        const { title, content, summary = "Created via MCP" } = 
          request.params.arguments as { title: string; content: string; summary?: string };
        
        const result = await wikiClient.createPage(title, content, summary);
        
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ 
              title,
              result: result.edit.result,
              newRevId: result.edit.newrevid,
              success: result.edit.result === "Success"
            }, null, 2)
          }]
        };
      }

      case "update_page": {
        const { title, content, summary = "Updated via MCP" } = 
          request.params.arguments as { title: string; content: string; summary?: string };
        
        const result = await wikiClient.updatePage(title, content, summary);
        
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ 
              title,
              result: result.edit.result,
              newRevId: result.edit.newrevid,
              success: result.edit.result === "Success"
            }, null, 2)
          }]
        };
      }

      case "get_page_history": {
        const { title, limit = 10 } = request.params.arguments as { title: string; limit?: number };
        const result = await wikiClient.getPageHistory(title, limit);
        
        const pages = result.query.pages;
        const page = pages[0];
        
        if (page.missing) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({ 
                title: page.title,
                exists: false,
                message: "Page does not exist"
              }, null, 2)
            }]
          };
        }
        
        const revisions = page.revisions.map((rev: any) => ({
          id: rev.revid,
          timestamp: rev.timestamp,
          user: rev.user,
          comment: rev.comment
        }));
        
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ 
              title: page.title,
              revisions
            }, null, 2)
          }]
        };
      }

      case "get_categories": {
        const { title } = request.params.arguments as { title: string };
        const result = await wikiClient.getCategories(title);
        
        const pages = result.query.pages;
        const page = pages[0];
        
        if (page.missing) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({ 
                title: page.title,
                exists: false,
                message: "Page does not exist"
              }, null, 2)
            }]
          };
        }
        
        const categories = page.categories 
          ? page.categories.map((cat: any) => cat.title)
          : [];
        
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ 
              title: page.title,
              categories
            }, null, 2)
          }]
        };
      }

      default:
        throw new Error(`Unknown tool: ${request.params.name}`);
    }
  } catch (error) {
    return {
      content: [{
        type: "text",
        text: `Error: ${error instanceof Error ? error.message : String(error)}`
      }],
      isError: true
    };
  }
});

// Start the server
async function runServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("MediaWiki MCP Server running on stdio");
  console.error(`Connected to MediaWiki API at: ${API_URL}`);
  console.error(`Authenticated user: ${USERNAME || 'None (anonymous mode)'}`);
}

// Try to log in before starting the server
wikiClient.login()
  .then(() => {
    console.error("Login successful");
  })
  .catch((error) => {
    console.error(`Login failed: ${error.message}`);
    console.error("Running in anonymous mode (read-only)");
  })
  .finally(() => {
    runServer().catch((error) => {
      console.error("Fatal error running server:", error);
      process.exit(1);
    });
  });
