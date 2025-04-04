#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool
} from "@modelcontextprotocol/sdk/types.js";
import fetch from "node-fetch";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import dotenv from "dotenv";
import path from "path";
import express, { Request, Response, NextFunction } from "express";
import http from "http";
import https from "https";
import fs from "fs";

// Load environment variables from .env file
dotenv.config();

// Configuration Types
interface Config {
  apiUrl: string;
  username: string;
  password: string;
  port: number;
  logLevel: "error" | "warn" | "info" | "debug";
  authTokenExpiry: number;
  retryAttempts: number;
  rateLimitWindow: number;
  rateLimitMaxRequests: number;
  cacheEnabled: boolean;
  cacheTTL: number;
  allowedOrigins: string;
  sslEnabled: boolean;
  sslKeyPath?: string;
  sslCertPath?: string;
}

// Helper function to get a required environment variable
const getRequiredEnv = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Required environment variable ${name} is not set`);
  }
  return value;
};

// Helper function to get an optional environment variable with a default value
const getOptionalEnv = <T>(
  name: string,
  defaultValue: T,
  transform?: (value: string) => T
): T => {
  const value = process.env[name];
  if (!value) {
    return defaultValue;
  }
  return transform ? transform(value) : (value as unknown as T);
};

// Configuration object with validation and defaults
const config: Config = {
  apiUrl: getRequiredEnv("MEDIAWIKI_API_URL"),
  username: getRequiredEnv("MEDIAWIKI_USERNAME"),
  password: getRequiredEnv("MEDIAWIKI_PASSWORD"),
  port: getOptionalEnv("PORT", 3000, Number),
  logLevel: getOptionalEnv("LOG_LEVEL", "info") as Config["logLevel"],
  authTokenExpiry: getOptionalEnv("AUTH_TOKEN_EXPIRY", 3600, Number),
  retryAttempts: getOptionalEnv("RETRY_ATTEMPTS", 3, Number),
  rateLimitWindow: getOptionalEnv("RATE_LIMIT_WINDOW", 900, Number),
  rateLimitMaxRequests: getOptionalEnv("RATE_LIMIT_MAX_REQUESTS", 100, Number),
  cacheEnabled: getOptionalEnv(
    "CACHE_ENABLED",
    true,
    (v) => v.toLowerCase() === "true"
  ),
  cacheTTL: getOptionalEnv("CACHE_TTL", 300, Number),
  allowedOrigins: getOptionalEnv("ALLOWED_ORIGINS", "*"),
  sslEnabled: getOptionalEnv(
    "SSL_ENABLED",
    false,
    (v) => v.toLowerCase() === "true"
  ),
  sslKeyPath: process.env.SSL_KEY_PATH,
  sslCertPath: process.env.SSL_CERT_PATH
};

// Validate SSL configuration
if (config.sslEnabled) {
  if (!config.sslKeyPath || !config.sslCertPath) {
    throw new Error(
      "SSL is enabled but SSL_KEY_PATH or SSL_CERT_PATH is not set"
    );
  }

  // Validate that SSL files exist
  const sslKeyPath = path.resolve(config.sslKeyPath);
  const sslCertPath = path.resolve(config.sslCertPath);

  try {
    fs.accessSync(sslKeyPath);
    fs.accessSync(sslCertPath);
  } catch (error) {
    throw new Error("SSL key or certificate file not found");
  }
}

// Create Express app
const app = express();

// Basic middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS middleware
const corsMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  res.header("Access-Control-Allow-Origin", config.allowedOrigins);
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.header(
    "Access-Control-Allow-Headers",
    "Origin, X-Requested-With, Content-Type, Accept, Authorization"
  );
  if (req.method === "OPTIONS") {
    res.sendStatus(200);
    return;
  }
  next();
};

app.use(corsMiddleware);

// Create HTTP(S) server
const httpServer =
  config.sslEnabled && config.sslKeyPath && config.sslCertPath
    ? https.createServer(
        {
          key: fs.readFileSync(config.sslKeyPath),
          cert: fs.readFileSync(config.sslCertPath)
        },
        app
      )
    : http.createServer(app);

// Start server
httpServer.listen(config.port, () => {
  console.log(
    `Server running on port ${config.port} (${
      config.sslEnabled ? "HTTPS" : "HTTP"
    })`
  );
});

// Parse command line arguments
const argv = yargs(hideBin(process.argv))
  .option("api-url", {
    type: "string",
    description: "MediaWiki API URL",
    default: "https://wizzypedia.forgottenrunes.com/api.php"
  })
  .option("username", {
    type: "string",
    description: "MediaWiki username"
  })
  .option("password", {
    type: "string",
    description: "MediaWiki password"
  })
  .help()
  .parseSync();

// Get MediaWiki API credentials from command line or environment variables
const API_URL = argv.apiUrl || process.env.MEDIAWIKI_API_URL;
const USERNAME = argv.username || process.env.MEDIAWIKI_USERNAME;
const PASSWORD = argv.password || process.env.MEDIAWIKI_PASSWORD;

if (!API_URL) {
  console.error(
    "MediaWiki API URL is required. Set it via --api-url or MEDIAWIKI_API_URL"
  );
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

  private async makeApiCall(
    params: Record<string, any>,
    method: "GET" | "POST" = "GET"
  ): Promise<any> {
    const url = new URL(this.apiUrl);

    // Set common parameters
    params.format = "json";
    params.formatversion = "2";

    const headers: Record<string, string> = {
      "User-Agent": "MediaWiki-MCP-Server/1.0"
    };

    if (this.cookies.length > 0) {
      headers["Cookie"] = this.cookies.join("; ");
    }

    let response;
    if (method === "GET") {
      // Append params to URL for GET requests
      Object.entries(params).forEach(([key, value]) => {
        if (value !== undefined) {
          url.searchParams.append(key, String(value));
        }
      });

      response = await fetch(url.toString(), { headers, method: "GET" });
    } else {
      // Create form data for POST requests
      const formData = new URLSearchParams();
      Object.entries(params).forEach(([key, value]) => {
        if (value !== undefined) {
          formData.append(key, String(value));
        }
      });

      response = await fetch(url.toString(), {
        method: "POST",
        headers: {
          ...headers,
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: formData
      });
    }

    // Save cookies from response
    const setCookieHeader = response.headers.get("Set-Cookie");
    if (setCookieHeader) {
      this.cookies.push(setCookieHeader);
    }

    const data = await response.json();
    if (data.error) {
      throw new Error(
        `MediaWiki API error: ${data.error.code} - ${data.error.info}`
      );
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
      action: "query",
      meta: "tokens",
      type: "login"
    });

    const loginToken = tokenResponse.query.tokens.logintoken;

    // Step 2: Perform login with token
    const loginResponse = await this.makeApiCall(
      {
        action: "login",
        lgname: this.username,
        lgpassword: this.password,
        lgtoken: loginToken
      },
      "POST"
    );

    if (loginResponse.login.result === "Success") {
      this.loggedIn = true;
      return true;
    } else {
      throw new Error(`Login failed: ${loginResponse.login.reason}`);
    }
  }

  async getEditToken(): Promise<string> {
    if (!this.editToken) {
      const tokenResponse = await this.makeApiCall({
        action: "query",
        meta: "tokens"
      });

      this.editToken = tokenResponse.query.tokens.csrftoken;
    }

    return this.editToken;
  }

  async searchPages(query: string, limit: number = 10): Promise<any> {
    return this.makeApiCall({
      action: "query",
      list: "search",
      srsearch: query,
      srlimit: limit,
      srinfo: "totalhits",
      srprop: "size|wordcount|timestamp|snippet"
    });
  }

  async getPage(title: string): Promise<any> {
    return this.makeApiCall({
      action: "query",
      prop: "revisions",
      titles: title,
      rvprop: "content|timestamp|user|comment",
      rvslots: "main"
    });
  }

  async createPage(
    title: string,
    content: string,
    summary: string = ""
  ): Promise<any> {
    // Ensure we have an edit token
    const token = await this.getEditToken();

    return this.makeApiCall(
      {
        action: "edit",
        title,
        text: content,
        summary,
        token,
        createonly: true
      },
      "POST"
    );
  }

  async updatePage(
    title: string,
    content: string,
    summary: string = ""
  ): Promise<any> {
    // Ensure we have an edit token
    const token = await this.getEditToken();

    return this.makeApiCall(
      {
        action: "edit",
        title,
        text: content,
        summary,
        token
      },
      "POST"
    );
  }

  async getPageHistory(title: string, limit: number = 10): Promise<any> {
    return this.makeApiCall({
      action: "query",
      prop: "revisions",
      titles: title,
      rvprop: "timestamp|user|comment|ids",
      rvlimit: limit
    });
  }

  async getCategories(title: string): Promise<any> {
    return this.makeApiCall({
      action: "query",
      prop: "categories",
      titles: title,
      cllimit: "max"
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
        description:
          "Maximum number of results to return (default: 10, max: 50)",
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
    version: "1.0.0"
  },
  {
    capabilities: {
      tools: {}
    }
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
  ]
}));

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    if (!request.params.arguments) {
      throw new Error("Arguments are required");
    }

    // Ensure we're logged in for operations that might need it
    if (
      request.params.name !== "search_pages" &&
      request.params.name !== "read_page"
    ) {
      await wikiClient.login();
    }

    switch (request.params.name) {
      case "search_pages": {
        const { query, limit = 10 } = request.params.arguments as {
          query: string;
          limit?: number;
        };
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
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  totalHits: result.query.searchinfo.totalhits,
                  pages
                },
                null,
                2
              )
            }
          ]
        };
      }

      case "read_page": {
        const { title } = request.params.arguments as { title: string };
        const result = await wikiClient.getPage(title);

        const pages = result.query.pages;
        const page = pages[0];

        if (page.missing) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    title: page.title,
                    exists: false,
                    message: "Page does not exist"
                  },
                  null,
                  2
                )
              }
            ]
          };
        }

        const revision = page.revisions[0];
        const content = revision.slots.main.content;

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  title: page.title,
                  content: content,
                  lastEdit: {
                    timestamp: revision.timestamp,
                    user: revision.user,
                    comment: revision.comment
                  }
                },
                null,
                2
              )
            }
          ]
        };
      }

      case "create_page": {
        const {
          title,
          content,
          summary = "Created via MCP"
        } = request.params.arguments as {
          title: string;
          content: string;
          summary?: string;
        };

        const result = await wikiClient.createPage(title, content, summary);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  title,
                  result: result.edit.result,
                  newRevId: result.edit.newrevid,
                  success: result.edit.result === "Success"
                },
                null,
                2
              )
            }
          ]
        };
      }

      case "update_page": {
        const {
          title,
          content,
          summary = "Updated via MCP"
        } = request.params.arguments as {
          title: string;
          content: string;
          summary?: string;
        };

        const result = await wikiClient.updatePage(title, content, summary);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  title,
                  result: result.edit.result,
                  newRevId: result.edit.newrevid,
                  success: result.edit.result === "Success"
                },
                null,
                2
              )
            }
          ]
        };
      }

      case "get_page_history": {
        const { title, limit = 10 } = request.params.arguments as {
          title: string;
          limit?: number;
        };
        const result = await wikiClient.getPageHistory(title, limit);

        const pages = result.query.pages;
        const page = pages[0];

        if (page.missing) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    title: page.title,
                    exists: false,
                    message: "Page does not exist"
                  },
                  null,
                  2
                )
              }
            ]
          };
        }

        const revisions = page.revisions.map((rev: any) => ({
          id: rev.revid,
          timestamp: rev.timestamp,
          user: rev.user,
          comment: rev.comment
        }));

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  title: page.title,
                  revisions
                },
                null,
                2
              )
            }
          ]
        };
      }

      case "get_categories": {
        const { title } = request.params.arguments as { title: string };
        const result = await wikiClient.getCategories(title);

        const pages = result.query.pages;
        const page = pages[0];

        if (page.missing) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    title: page.title,
                    exists: false,
                    message: "Page does not exist"
                  },
                  null,
                  2
                )
              }
            ]
          };
        }

        const categories = page.categories
          ? page.categories.map((cat: any) => cat.title)
          : [];

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  title: page.title,
                  categories
                },
                null,
                2
              )
            }
          ]
        };
      }

      default:
        throw new Error(`Unknown tool: ${request.params.name}`);
    }
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: `Error: ${
            error instanceof Error ? error.message : String(error)
          }`
        }
      ],
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
  console.error(`Authenticated user: ${USERNAME || "None (anonymous mode)"}`);
}

// Try to log in before starting the server
wikiClient
  .login()
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
