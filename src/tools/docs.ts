import { z } from 'zod';
import { ProductiveAPIClient } from '../api/client.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { ProductiveIncludedResource } from '../api/types.js';

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
    // If body is not valid JSON, return as-is (might be plain text)
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

// --- list_docs ---

const listDocsSchema = z.object({
  project_id: z.string().optional(),
  creator_id: z.string().optional(),
  limit: z.number().min(1).max(200).default(30).optional(),
  page: z.number().min(1).optional(),
});

export async function listDocsTool(
  client: ProductiveAPIClient,
  args: unknown
): Promise<{ content: Array<{ type: string; text: string }> }> {
  try {
    const params = listDocsSchema.parse(args);

    const response = await client.listPages({
      project_id: params.project_id,
      creator_id: params.creator_id,
      limit: params.limit,
      page: params.page,
    });

    if (!response.data || response.data.length === 0) {
      return {
        content: [{ type: 'text', text: 'No docs/pages found.' }],
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

    const docs = response.data.map((page) => {
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
      if (rootPageId && !isRootDoc) text += `\n  Root doc ID: ${rootPageId}`;
      if (parentPageId) text += `\n  Parent page ID: ${parentPageId}`;
      text += `\n  Created: ${attrs.created_at}`;
      if (attrs.edited_at) text += ` | Edited: ${attrs.edited_at}`;

      return text;
    });

    let result = `Docs/Pages (${response.data.length}`;
    if (response.meta?.total_count) {
      result += ` of ${response.meta.total_count}`;
    }
    result += `):\n\n${docs.join('\n\n')}`;

    return {
      content: [{ type: 'text', text: result }],
    };
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Invalid parameters: ${error.errors.map(e => e.message).join(', ')}`
      );
    }
    throw new McpError(
      ErrorCode.InternalError,
      error instanceof Error ? error.message : 'Unknown error occurred'
    );
  }
}

export const listDocsDefinition = {
  name: 'list_docs',
  description: 'List docs/pages from Productive.io. Docs are hierarchical: root docs contain child pages. Filter by project or creator.',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: {
        type: 'string',
        description: 'Filter docs by project ID',
      },
      creator_id: {
        type: 'string',
        description: 'Filter docs by creator person ID',
      },
      limit: {
        type: 'number',
        minimum: 1,
        maximum: 200,
        default: 30,
        description: 'Number of results per page (default: 30, max: 200)',
      },
      page: {
        type: 'number',
        minimum: 1,
        description: 'Page number for pagination',
      },
    },
  },
};

// --- create_doc ---

const createDocSchema = z.object({
  title: z.string().min(1, 'Title is required'),
  body: z.union([z.string(), z.record(z.any())]).optional(),
  project_id: z.string().min(1, 'Project ID is required'),
  parent_page_id: z.string().optional(),
});

/**
 * Convert plain text to Productive's ProseMirror-like JSON doc format.
 * Splits on double newlines into paragraphs.
 */
function textToDocBody(text: string): string {
  const paragraphs = text.split(/\n{2,}/).filter(p => p.trim());
  const content = paragraphs.map(p => ({
    type: 'paragraph',
    content: [{ type: 'text', text: p.trim() }],
  }));
  return JSON.stringify({ type: 'doc', content });
}

/**
 * Normalize a doc body value into a valid JSON string for the Productive API.
 * Handles: objects (from MCP parsing), valid JSON strings, truncated JSON, and plain text.
 */
function normalizeDocBody(body: unknown): string {
  // Case 1: body arrived as a parsed object (MCP framework may parse JSON params)
  if (typeof body === 'object' && body !== null) {
    const obj = body as Record<string, unknown>;
    if (obj.type === 'doc' && Array.isArray(obj.content)) {
      return JSON.stringify(body);
    }
    throw new McpError(
      ErrorCode.InvalidParams,
      'Invalid doc body object: must have type "doc" and content array'
    );
  }

  if (typeof body !== 'string') {
    throw new McpError(ErrorCode.InvalidParams, 'Body must be a string or doc JSON object');
  }

  // Case 2: looks like JSON doc format — validate it fully
  if (body.trimStart().startsWith('{')) {
    try {
      const parsed = JSON.parse(body);
      if (parsed?.type === 'doc' && Array.isArray(parsed?.content)) {
        return body; // Valid JSON doc string, pass through
      }
    } catch {
      // Starts with { but fails to parse — likely truncated JSON. Reject it.
      throw new McpError(
        ErrorCode.InvalidParams,
        'Body appears to be JSON but failed to parse (possibly truncated). Cannot safely update.'
      );
    }
  }

  // Case 3: plain text — convert to doc format
  return textToDocBody(body);
}

export async function createDocTool(
  client: ProductiveAPIClient,
  args: unknown
): Promise<{ content: Array<{ type: string; text: string }> }> {
  try {
    const params = createDocSchema.parse(args);

    // Normalize body: handles objects, JSON strings, plain text, and truncated JSON
    const body = params.body !== undefined ? normalizeDocBody(params.body) : undefined;

    const parentId = params.parent_page_id
      ? parseInt(params.parent_page_id, 10)
      : undefined;

    const response = await client.createPage({
      data: {
        type: 'pages',
        attributes: {
          title: params.title,
          ...(body ? { body } : {}),
          ...(parentId ? { parent_page_id: parentId, root_page_id: parentId } : {}),
        },
        relationships: {
          project: {
            data: { id: params.project_id, type: 'projects' },
          },
        },
      },
    });

    const page = response.data;
    let text = `Doc created successfully!\n`;
    text += `Title: ${page.attributes.title}\n`;
    text += `ID: ${page.id}\n`;
    text += `Project ID: ${params.project_id}\n`;
    if (params.parent_page_id) text += `Parent page ID: ${params.parent_page_id}\n`;
    if (page.attributes.created_at) text += `Created: ${page.attributes.created_at}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Invalid parameters: ${error.errors.map(e => e.message).join(', ')}`
      );
    }
    throw new McpError(
      ErrorCode.InternalError,
      error instanceof Error ? error.message : 'Unknown error occurred'
    );
  }
}

export const createDocDefinition = {
  name: 'create_doc',
  description: 'Create a new doc/page in Productive.io. Can create root docs or sub-pages under an existing doc. Body can be plain text (auto-converted) or raw ProseMirror JSON.',
  inputSchema: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: 'Title of the doc/page (required)',
      },
      body: {
        type: 'string',
        description: 'Content of the doc. Plain text (auto-converted to doc format) or raw ProseMirror JSON (if starts with {"type":"doc",...})',
      },
      project_id: {
        type: 'string',
        description: 'Project ID to create the doc under (required)',
      },
      parent_page_id: {
        type: 'string',
        description: 'Parent page ID to create a sub-page under an existing doc. Omit to create a root doc.',
      },
    },
    required: ['title', 'project_id'],
  },
};

// --- update_doc ---

const updateDocSchema = z.object({
  page_id: z.string().min(1, 'Page ID is required'),
  title: z.string().min(1).optional(),
  body: z.union([z.string(), z.record(z.any())]).optional(),
});

export async function updateDocTool(
  client: ProductiveAPIClient,
  args: unknown
): Promise<{ content: Array<{ type: string; text: string }> }> {
  try {
    const params = updateDocSchema.parse(args);

    if (!params.title && params.body === undefined) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'At least one field (title or body) must be provided for update'
      );
    }

    // Normalize body: handles objects, JSON strings, plain text, and truncated JSON
    const body = params.body !== undefined ? normalizeDocBody(params.body) : undefined;

    const response = await client.updatePage(params.page_id, {
      data: {
        type: 'pages',
        id: params.page_id,
        attributes: {
          ...(params.title ? { title: params.title } : {}),
          ...(body !== undefined ? { body } : {}),
        },
      },
    });

    const page = response.data;
    let text = `Doc updated successfully!\n`;
    text += `ID: ${page.id}\n`;
    text += `Title: ${page.attributes.title}\n`;
    if (params.title) text += `✓ Title updated\n`;
    if (params.body !== undefined) text += `✓ Body updated\n`;
    text += `Updated: ${page.attributes.updated_at}\n`;
    text += `\n⚠️ Note: Changes may take up to 1 hour to appear if the doc is open in the UI.`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Invalid parameters: ${error.errors.map(e => e.message).join(', ')}`
      );
    }
    if (error instanceof McpError) throw error;
    throw new McpError(
      ErrorCode.InternalError,
      error instanceof Error ? error.message : 'Unknown error occurred'
    );
  }
}

export const updateDocDefinition = {
  name: 'update_doc',
  description: 'Update an existing doc/page in Productive.io. Can update title and/or body. WARNING: Do not update while the doc is open in the UI. Body can be plain text or raw ProseMirror JSON.',
  inputSchema: {
    type: 'object',
    properties: {
      page_id: {
        type: 'string',
        description: 'The ID of the doc/page to update (required)',
      },
      title: {
        type: 'string',
        description: 'New title for the doc (optional)',
      },
      body: {
        type: 'string',
        description: 'New content. Plain text (auto-converted) or raw ProseMirror JSON. Use empty string to clear.',
      },
    },
    required: ['page_id'],
  },
};

// --- get_doc ---

const getDocSchema = z.object({
  page_id: z.string().min(1, 'Page ID is required'),
});

export async function getDocTool(
  client: ProductiveAPIClient,
  args: unknown
): Promise<{ content: Array<{ type: string; text: string }> }> {
  try {
    const params = getDocSchema.parse(args);

    const response = await client.getPage(params.page_id);
    const page = response.data;
    const attrs = page.attributes;

    const creatorId = page.relationships?.creator?.data?.id;
    const creatorName = resolvePersonName(creatorId, response.included);
    const projectId = page.relationships?.project?.data?.id;
    const parentPageId = page.relationships?.parent_page?.data?.id;
    const rootPageId = page.relationships?.root_page?.data?.id;

    let text = `Doc/Page Details:\n\n`;
    text += `Title: ${attrs.title}\n`;
    text += `ID: ${page.id}\n`;
    if (projectId) text += `Project ID: ${projectId}\n`;
    if (creatorName) {
      text += `Creator: ${creatorName} (ID: ${creatorId})\n`;
    } else if (creatorId) {
      text += `Creator ID: ${creatorId}\n`;
    }
    if (rootPageId) text += `Root doc ID: ${rootPageId}\n`;
    if (parentPageId) text += `Parent page ID: ${parentPageId}\n`;
    text += `Created: ${attrs.created_at}\n`;
    if (attrs.edited_at) text += `Edited: ${attrs.edited_at}\n`;
    text += `Updated: ${attrs.updated_at}\n`;

    if (attrs.body) {
      const rendered = renderDocBody(attrs.body);
      if (rendered.trim()) {
        text += `\n--- Content ---\n${rendered}`;
      }
    }

    return {
      content: [{ type: 'text', text }],
    };
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Invalid parameters: ${error.errors.map(e => e.message).join(', ')}`
      );
    }
    throw new McpError(
      ErrorCode.InternalError,
      error instanceof Error ? error.message : 'Unknown error occurred'
    );
  }
}

export const getDocDefinition = {
  name: 'get_doc',
  description: 'Get a specific doc/page from Productive.io by its page ID. Returns title, metadata, and rendered content.',
  inputSchema: {
    type: 'object',
    properties: {
      page_id: {
        type: 'string',
        description: 'The ID of the doc/page to retrieve (required)',
      },
    },
    required: ['page_id'],
  },
};
