# MediaWiki MCP Server

This is a [Model Context Protocol (MCP)](https://github.com/anthropics/anthropic-cookbook/tree/main/tools_and_apis/mcp) server for interacting with MediaWiki APIs, designed to work with MCP-enabled editors like Cursor.

## Features

- Search for wiki pages
- Read page content
- Create new pages
- Update existing pages
- View page history
- List page categories

## Installation

```bash
npm install
npm run build
```

## Usage

Run the server with:

```bash
# With environment variables
export MEDIAWIKI_API_URL="https://en.wikipedia.org/w/api.php"
export MEDIAWIKI_USERNAME="YourUsername"
export MEDIAWIKI_PASSWORD="YourPassword"
node dist/index.js

# Or with command line arguments
node dist/index.js --api-url="https://en.wikipedia.org/w/api.php" --username="YourUsername" --password="YourPassword"
```

### Anonymous Mode

You can run the server without authentication for read-only operations:

```bash
node dist/index.js --api-url="https://en.wikipedia.org/w/api.php"
```

## Available Tools

The server provides the following MCP tools:

1. **search_pages** - Search for pages in the wiki
2. **read_page** - Fetch the raw wikitext content of a page
3. **create_page** - Create a new wiki page
4. **update_page** - Update an existing wiki page
5. **get_page_history** - Get revision history of a page
6. **get_categories** - Get categories a page belongs to

## Using with Cursor

Once the server is running, you can connect to it from Cursor or another MCP-compatible client. This allows you to:

1. Search for wiki content
2. Load wiki content into your editor
3. Edit content locally
4. Save changes back to the wiki

## License

MIT
