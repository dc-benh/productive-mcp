import { z } from 'zod';
import { ProductiveAPIClient } from '../api/client.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { ProductiveIncludedResource } from '../api/types.js';
import { Config } from '../config/index.js';
import { syncPageToCollab, normaliseNodeTypes } from './page-collab.js';

/**
 * Convert Productive document JSON body to readable plain text.
 * The body uses a ProseMirror-like JSON format.
 */
function renderDocBody(bodyJson: string): string {
  try {
    const doc = JSON.parse(bodyJson);
    if (!doc || !doc.content) return '';
    return renderNodes(doc.content, 0);
  } catch {
    // If body is not valid JSON, return as-is (might be plain text or HTML)
    return bodyJson;
  }
}

function renderNodes(nodes: any[], depth: number): string {
  if (!Array.isArray(nodes)) return '';
  return nodes.map(node => renderNode(node, depth)).join('');
}

function renderNode(node: any, depth: number): string {
  if (!node || !node.type) return '';

  switch (node.type) {
    case 'text':
      return node.text || '';
    case 'paragraph':
      return renderNodes(node.content || [], depth) + '\n';
    case 'heading': {
      const level = node.attrs?.level || 1;
      const prefix = '#'.repeat(level) + ' ';
      return prefix + renderNodes(node.content || [], depth) + '\n';
    }
    case 'ul':
    case 'bullet_list':
      return renderNodes(node.content || [], depth) + '\n';
    case 'ol':
    case 'ordered_list':
      return renderNodes(node.content || [], depth) + '\n';
    case 'li':
    case 'list_item':
      return '  '.repeat(depth) + '- ' + renderNodes(node.content || [], depth + 1).trim() + '\n';
    case 'checklist':
      return renderNodes(node.content || [], depth) + '\n';
    case 'checklist_item': {
      const checked = node.attrs?.checked ? '[x]' : '[ ]';
      return '  '.repeat(depth) + checked + ' ' + renderNodes(node.content || [], depth + 1).trim() + '\n';
    }
    case 'blockquote':
      return renderNodes(node.content || [], depth).split('\n').map((l: string) => '> ' + l).join('\n') + '\n';
    case 'divider':
    case 'horizontal_rule':
      return '---\n';
    case 'table':
      return renderNodes(node.content || [], depth) + '\n';
    case 'table_row':
      return '| ' + (node.content || []).map((cell: any) => renderNodes(cell.content || [], depth).trim()).join(' | ') + ' |\n';
    case 'br':
    case 'hard_break':
      return '\n';
    default:
      // For unknown node types, try to render children
      if (node.content) {
        return renderNodes(node.content, depth);
      }
      return '';
  }
}

function resolvePersonName(personId: string | undefined, included?: ProductiveIncludedResource[]): string | undefined {
  if (!personId || !included) return undefined;
  const person = included.find(item => item.type === 'people' && item.id === personId);
  if (!person) return undefined;
  const first = person.attributes.first_name || '';
  const last = person.attributes.last_name || '';
  return `${first} ${last}`.trim() || undefined;
}

/**
 * Normalize a page body value for the Productive API.
 * The API natively handles plain text, HTML, and ProseMirror JSON —
 * pass content through without client-side conversion so the server
 * can process it correctly (including versioning and ID generation).
 */
function normalizePageBody(body: unknown): string {
  // Case 1: body arrived as a parsed object (MCP framework may parse JSON params)
  if (typeof body === 'object' && body !== null) {
    const obj = body as Record<string, unknown>;
    if (obj.type === 'doc' && Array.isArray(obj.content)) {
      // Normalise node types to collab-compatible schema before storing
      return JSON.stringify(normaliseNodeTypes(body));
    }
    throw new McpError(
      ErrorCode.InvalidParams,
      'Invalid page body object: must have type "doc" and content array'
    );
  }

  if (typeof body !== 'string') {
    throw new McpError(ErrorCode.InvalidParams, 'Body must be a string or doc JSON object');
  }

  // Guard against truncated JSON and normalise ProseMirror node types.
  if (body.trimStart().startsWith('{')) {
    let parsed: any;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new McpError(
        ErrorCode.InvalidParams,
        'Body appears to be JSON but failed to parse (possibly truncated). Cannot safely save.'
      );
    }
    // If it's ProseMirror doc JSON, normalise node types to collab schema
    if (parsed?.type === 'doc' && Array.isArray(parsed.content)) {
      return JSON.stringify(normaliseNodeTypes(parsed));
    }
  }

  // Pass through as-is: the Productive API handles plain text, HTML,
  // and ProseMirror JSON natively with proper editor state management.
  return body;
}

// ---- list_pages ----

const listPagesSchema = z.object({
  project_id: z.string().optional(),
  creator_id: z.string().optional(),
  sort: z.enum(['created_at', 'title', 'edited_at', 'updated_at']).optional(),
  limit: z.number().min(1).max(200).default(30).optional(),
  page: z.number().min(1).optional(),
});

export async function listPagesTool(
  client: ProductiveAPIClient,
  args: unknown
): Promise<{ content: Array<{ type: string; text: string }> }> {
  try {
    const params = listPagesSchema.parse(args);

    const response = await client.listPages({
      project_id: params.project_id,
      creator_id: params.creator_id,
      sort: params.sort,
      limit: params.limit,
      page: params.page,
    });

    if (!response.data || response.data.length === 0) {
      return {
        content: [{ type: 'text', text: 'No pages found.' }],
      };
    }

    const includedPeople = new Map<string, string>();
    if (response.included) {
      for (const item of response.included) {
        if (item.type === 'people' && item.attributes) {
          includedPeople.set(item.id, `${item.attributes.first_name ?? ''} ${item.attributes.last_name ?? ''}`.trim());
        }
      }
    }

    const pages = response.data.map((page) => {
      const attrs = page.attributes;
      const creatorId = page.relationships?.creator?.data?.id;
      const creatorName = creatorId ? includedPeople.get(creatorId) : undefined;
      const projectId = page.relationships?.project?.data?.id;
      const parentPageId = page.relationships?.parent_page?.data?.id;
      const rootPageId = page.relationships?.root_page?.data?.id;
      const isRootDoc = !parentPageId;

      let text = `${isRootDoc ? '📄' : '  📃'} ${attrs.title} (ID: ${page.id})`;
      if (creatorName) text += `\n  Creator: ${creatorName}`;
      if (projectId) text += `\n  Project ID: ${projectId}`;
      if (rootPageId && !isRootDoc) text += `\n  Root page ID: ${rootPageId}`;
      if (parentPageId) text += `\n  Parent page ID: ${parentPageId}`;
      text += `\n  Created: ${attrs.created_at}`;
      if (attrs.edited_at) text += ` | Edited: ${attrs.edited_at}`;
      if (attrs.version_number != null) text += ` | Version: ${attrs.version_number}`;

      return text;
    });

    let result = `Pages (${response.data.length}`;
    if (response.meta?.total_count) {
      result += ` of ${response.meta.total_count}`;
    }
    result += `):\n\n${pages.join('\n\n')}`;

    return {
      content: [{ type: 'text', text: result }],
    };
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new McpError(ErrorCode.InvalidParams, `Invalid parameters: ${error.errors.map(e => e.message).join(', ')}`);
    }
    throw new McpError(ErrorCode.InternalError, error instanceof Error ? error.message : 'Unknown error occurred');
  }
}

export const listPagesDefinition = {
  name: 'list_pages',
  description: 'List pages/documents from Productive.io. Pages are hierarchical: root pages contain child pages. Filter by project or creator.',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: 'string', description: 'Filter pages by project ID' },
      creator_id: { type: 'string', description: 'Filter pages by creator person ID' },
      sort: {
        type: 'string',
        enum: ['created_at', 'title', 'edited_at', 'updated_at'],
        description: 'Sort field',
      },
      limit: { type: 'number', minimum: 1, maximum: 200, default: 30, description: 'Results per page (default: 30, max: 200)' },
      page: { type: 'number', minimum: 1, description: 'Page number for pagination' },
    },
  },
};

// ---- get_page ----

const getPageSchema = z.object({
  page_id: z.string().min(1, 'Page ID is required'),
});

export async function getPageTool(
  client: ProductiveAPIClient,
  args: unknown
): Promise<{ content: Array<{ type: string; text: string }> }> {
  try {
    const params = getPageSchema.parse(args);

    const response = await client.getPage(params.page_id);
    const page = response.data;
    const attrs = page.attributes;

    const creatorId = page.relationships?.creator?.data?.id;
    const creatorName = resolvePersonName(creatorId, response.included);
    const projectId = page.relationships?.project?.data?.id;
    const parentPageId = page.relationships?.parent_page?.data?.id;
    const rootPageId = page.relationships?.root_page?.data?.id;

    let text = `Page Details:\n\n`;
    text += `Title: ${attrs.title}\n`;
    text += `ID: ${page.id}\n`;
    if (projectId) text += `Project ID: ${projectId}\n`;
    if (creatorName) {
      text += `Creator: ${creatorName} (ID: ${creatorId})\n`;
    } else if (creatorId) {
      text += `Creator ID: ${creatorId}\n`;
    }
    if (rootPageId) text += `Root page ID: ${rootPageId}\n`;
    if (parentPageId) text += `Parent page ID: ${parentPageId}\n`;
    if (attrs.version_number != null) text += `Version: ${attrs.version_number}\n`;
    text += `Created: ${attrs.created_at}\n`;
    if (attrs.edited_at) text += `Edited: ${attrs.edited_at}\n`;
    text += `Updated: ${attrs.updated_at}\n`;

    if (attrs.body) {
      const rendered = renderDocBody(attrs.body);
      if (rendered.trim()) {
        text += `\n--- Content (rendered) ---\n${rendered}`;
      }
      // Include raw body for lossless round-trips
      text += `\n--- Raw Body ---\n${attrs.body}`;
    }

    return {
      content: [{ type: 'text', text }],
    };
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new McpError(ErrorCode.InvalidParams, `Invalid parameters: ${error.errors.map(e => e.message).join(', ')}`);
    }
    throw new McpError(ErrorCode.InternalError, error instanceof Error ? error.message : 'Unknown error occurred');
  }
}

export const getPageDefinition = {
  name: 'get_page',
  description: 'Get a specific page/document from Productive.io by its page ID. Returns title, metadata, rendered content, and raw body (for lossless round-trip updates).',
  inputSchema: {
    type: 'object',
    properties: {
      page_id: { type: 'string', description: 'The ID of the page to retrieve (required)' },
    },
    required: ['page_id'],
  },
};

// ---- create_page ----

const createPageSchema = z.object({
  title: z.string().min(1, 'Title is required'),
  body: z.union([z.string(), z.record(z.any())]).optional(),
  project_id: z.string().min(1, 'Project ID is required'),
  parent_page_id: z.string().optional(),
});

export async function createPageTool(
  client: ProductiveAPIClient,
  args: unknown
): Promise<{ content: Array<{ type: string; text: string }> }> {
  try {
    const params = createPageSchema.parse(args);

    const body = params.body !== undefined ? normalizePageBody(params.body) : undefined;

    // Resolve parent_page_id and root_page_id.
    // When nesting under a non-root page, root_page_id must point to the
    // actual root doc, not the immediate parent.
    let parentAttrs: { parent_page_id: number; root_page_id: number } | undefined;
    if (params.parent_page_id) {
      const parentId = parseInt(params.parent_page_id, 10);
      const parentPage = await client.getPage(params.parent_page_id);
      const parentRootId = parentPage.data.relationships?.root_page?.data?.id;
      const rootId = parentRootId ? parseInt(parentRootId, 10) : parentId;
      parentAttrs = { parent_page_id: parentId, root_page_id: rootId };
    }

    const response = await client.createPage({
      data: {
        type: 'pages',
        attributes: {
          title: params.title,
          ...(body ? { body, version_number: 1 } : {}),
          ...(parentAttrs ?? {}),
        },
        relationships: {
          project: {
            data: { id: params.project_id, type: 'projects' },
          },
        },
      },
    });

    const page = response.data;
    let text = `Page created successfully!\n`;
    text += `Title: ${page.attributes.title}\n`;
    text += `ID: ${page.id}\n`;
    text += `Project ID: ${params.project_id}\n`;
    if (params.parent_page_id) text += `Parent page ID: ${params.parent_page_id}\n`;
    if (page.attributes.created_at) text += `Created: ${page.attributes.created_at}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new McpError(ErrorCode.InvalidParams, `Invalid parameters: ${error.errors.map(e => e.message).join(', ')}`);
    }
    if (error instanceof McpError) throw error;
    throw new McpError(ErrorCode.InternalError, error instanceof Error ? error.message : 'Unknown error occurred');
  }
}

export const createPageDefinition = {
  name: 'create_page',
  description: 'Create a new page/document in Productive.io. Can create root pages or sub-pages under an existing page. Body supports plain text, HTML (for rich formatting), or raw ProseMirror JSON.',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Title of the page (required)' },
      body: { type: 'string', description: 'Content of the page. Supports plain text, HTML (recommended for rich content), or raw ProseMirror JSON.' },
      project_id: { type: 'string', description: 'Project ID to create the page under (required)' },
      parent_page_id: { type: 'string', description: 'Parent page ID to create a sub-page. Omit to create a root page. root_page_id is auto-resolved.' },
    },
    required: ['title', 'project_id'],
  },
};

// ---- update_page ----

const updatePageSchema = z.object({
  page_id: z.string().min(1, 'Page ID is required'),
  title: z.string().min(1).optional(),
  body: z.union([z.string(), z.record(z.any())]).optional(),
});

export async function updatePageTool(
  client: ProductiveAPIClient,
  args: unknown,
  config?: Config
): Promise<{ content: Array<{ type: string; text: string }> }> {
  try {
    const params = updatePageSchema.parse(args);

    if (!params.title && params.body === undefined) {
      throw new McpError(ErrorCode.InvalidParams, 'At least one field (title or body) must be provided for update');
    }

    const body = params.body !== undefined ? normalizePageBody(params.body) : undefined;

    // Fetch current page for metadata
    const current = await client.getPage(params.page_id);
    const rootPageId = current.data.relationships?.root_page?.data?.id ?? params.page_id;

    let text = `Page updated successfully!\n`;
    text += `ID: ${params.page_id}\n`;

    // Title updates go through REST API (collab doesn't handle titles)
    if (params.title) {
      const currentVersion = current.data.attributes.version_number;
      const nextVersion = currentVersion ? currentVersion + 1 : 1;

      const response = await client.updatePage(params.page_id, {
        data: {
          type: 'pages',
          id: params.page_id,
          attributes: {
            title: params.title,
            version_number: nextVersion,
          },
        },
      });
      text += `Title: ${response.data.attributes.title}\n`;
      text += `✓ Title updated\n`;
    } else {
      text += `Title: ${current.data.attributes.title}\n`;
    }

    // Body updates go through collab channel ONLY (not REST API).
    // Writing body to both REST API and collab causes version conflicts
    // that result in "Unsaved" badges and autorecovery copies in the UI.
    if (body !== undefined && config) {
      // If body is HTML/text (not ProseMirror JSON), we need REST API to convert it.
      // Write it, read back the ProseMirror JSON, then use that for collab sync.
      let pmBody = body;
      const isJson = body.trimStart().startsWith('{');
      if (!isJson) {
        // HTML/text body: use REST API as a converter only
        const currentVersion = current.data.attributes.version_number;
        const nextVersion = currentVersion ? currentVersion + 1 : 1;
        await client.updatePage(params.page_id, {
          data: {
            type: 'pages',
            id: params.page_id,
            attributes: { body, version_number: nextVersion },
          },
        });
        const converted = await client.getPage(params.page_id);
        pmBody = converted.data.attributes.body || body;
      }

      const warning = await syncPageToCollab(config, params.page_id, rootPageId, pmBody);
      if (warning) {
        text += `\n⚠️ ${warning}`;
      } else {
        text += `✓ Body updated via collab sync\n`;
      }
    } else if (body !== undefined) {
      // No config available - fall back to REST API only
      const currentVersion = current.data.attributes.version_number;
      const nextVersion = currentVersion ? currentVersion + 1 : 1;
      await client.updatePage(params.page_id, {
        data: {
          type: 'pages',
          id: params.page_id,
          attributes: { body, version_number: nextVersion },
        },
      });
      text += `✓ Body updated (REST API only - may show "Unsaved" in UI)\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new McpError(ErrorCode.InvalidParams, `Invalid parameters: ${error.errors.map(e => e.message).join(', ')}`);
    }
    if (error instanceof McpError) throw error;
    const msg = error instanceof Error ? error.message : 'Unknown error occurred';
    if (msg.includes('version_number') || msg.includes('must be incremented')) {
      throw new McpError(ErrorCode.InternalError, 'Version conflict: the page was modified by someone else (or is open in the UI). Close the page and try again.');
    }
    throw new McpError(ErrorCode.InternalError, msg);
  }
}

export const updatePageDefinition = {
  name: 'update_page',
  description: 'Update an existing page/document in Productive.io. Can update title and/or body. Body updates are synced to the collab server so changes appear in the UI. Supports plain text, HTML, or raw ProseMirror JSON.',
  inputSchema: {
    type: 'object',
    properties: {
      page_id: { type: 'string', description: 'The ID of the page to update (required)' },
      title: { type: 'string', description: 'New title for the page (optional)' },
      body: { type: 'string', description: 'New content. For lossless updates, pass the raw body from get_page. Supports plain text, HTML, or ProseMirror JSON.' },
    },
    required: ['page_id'],
  },
};

// ---- delete_page ----

const deletePageSchema = z.object({
  page_id: z.string().min(1, 'Page ID is required'),
});

export async function deletePageTool(
  client: ProductiveAPIClient,
  args: unknown
): Promise<{ content: Array<{ type: string; text: string }> }> {
  try {
    const params = deletePageSchema.parse(args);
    await client.deletePage(params.page_id);
    return {
      content: [{ type: 'text', text: `Page ${params.page_id} deleted successfully.` }],
    };
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new McpError(ErrorCode.InvalidParams, `Invalid parameters: ${error.errors.map(e => e.message).join(', ')}`);
    }
    throw new McpError(ErrorCode.InternalError, error instanceof Error ? error.message : 'Unknown error occurred');
  }
}

export const deletePageDefinition = {
  name: 'delete_page',
  description: 'Delete a page/document from Productive.io. This action cannot be undone.',
  inputSchema: {
    type: 'object',
    properties: {
      page_id: { type: 'string', description: 'The ID of the page to delete (required)' },
    },
    required: ['page_id'],
  },
};

// ---- move_page ----

const movePageSchema = z.object({
  page_id: z.string().min(1, 'Page ID is required'),
  target_doc_id: z.string().min(1, 'Target document ID is required'),
});

export async function movePageTool(
  client: ProductiveAPIClient,
  args: unknown
): Promise<{ content: Array<{ type: string; text: string }> }> {
  try {
    const params = movePageSchema.parse(args);
    await client.movePage(params.page_id, params.target_doc_id);
    return {
      content: [{ type: 'text', text: `Page ${params.page_id} moved to document ${params.target_doc_id} successfully.` }],
    };
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new McpError(ErrorCode.InvalidParams, `Invalid parameters: ${error.errors.map(e => e.message).join(', ')}`);
    }
    throw new McpError(ErrorCode.InternalError, error instanceof Error ? error.message : 'Unknown error occurred');
  }
}

export const movePageDefinition = {
  name: 'move_page',
  description: 'Move a page under a different parent document in Productive.io.',
  inputSchema: {
    type: 'object',
    properties: {
      page_id: { type: 'string', description: 'The ID of the page to move (required)' },
      target_doc_id: { type: 'string', description: 'The ID of the target parent document (required)' },
    },
    required: ['page_id', 'target_doc_id'],
  },
};

// ---- copy_page ----

const copyPageSchema = z.object({
  template_id: z.string().min(1, 'Template ID (page to copy) is required'),
  project_id: z.string().optional(),
});

export async function copyPageTool(
  client: ProductiveAPIClient,
  args: unknown
): Promise<{ content: Array<{ type: string; text: string }> }> {
  try {
    const params = copyPageSchema.parse(args);
    const response = await client.copyPage(params.template_id, params.project_id);
    const page = response.data;
    let text = `Page copied successfully!\n`;
    text += `New page ID: ${page.id}\n`;
    text += `Title: ${page.attributes.title}\n`;
    if (page.attributes.created_at) text += `Created: ${page.attributes.created_at}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new McpError(ErrorCode.InvalidParams, `Invalid parameters: ${error.errors.map(e => e.message).join(', ')}`);
    }
    throw new McpError(ErrorCode.InternalError, error instanceof Error ? error.message : 'Unknown error occurred');
  }
}

export const copyPageDefinition = {
  name: 'copy_page',
  description: 'Copy a page from a template in Productive.io.',
  inputSchema: {
    type: 'object',
    properties: {
      template_id: { type: 'string', description: 'The ID of the page to copy (required)' },
      project_id: { type: 'string', description: 'Project ID to copy into (defaults to same project)' },
    },
    required: ['template_id'],
  },
};
