import { z } from 'zod';
import { ProductiveAPIClient } from '../api/client.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { ProductiveIncludedResource } from '../api/types.js';

type ToolResult = { content: Array<{ type: string; text: string }> };

function resolvePersonName(personId: string | undefined, included?: ProductiveIncludedResource[]): string | undefined {
  if (!personId || !included) return undefined;
  const person = included.find(item => item.type === 'people' && item.id === personId);
  if (!person) return undefined;
  const first = person.attributes.first_name || '';
  const last = person.attributes.last_name || '';
  return `${first} ${last}`.trim() || undefined;
}

// ---- List Comments ----

const listCommentsSchema = z.object({
  task_id: z.string().optional(),
  project_id: z.string().optional(),
  discussion_id: z.string().optional(),
  draft: z.boolean().optional(),
  limit: z.number().min(1).max(200).default(30).optional(),
  page: z.number().min(1).optional(),
});

export async function listCommentsTool(
  client: ProductiveAPIClient,
  args: unknown
): Promise<ToolResult> {
  try {
    const params = listCommentsSchema.parse(args);

    const response = await client.listComments({
      task_id: params.task_id,
      project_id: params.project_id,
      discussion_id: params.discussion_id,
      draft: params.draft,
      limit: params.limit,
      page: params.page,
    });

    if (!response.data || response.data.length === 0) {
      return {
        content: [{ type: 'text', text: 'No comments found.' }],
      };
    }

    const includedPeople = new Map<string, string>();
    if (response.included) {
      for (const item of response.included) {
        if (item.type === 'people' && item.attributes) {
          const attrs = item.attributes as Record<string, string>;
          includedPeople.set(item.id, `${attrs.first_name ?? ''} ${attrs.last_name ?? ''}`.trim());
        }
      }
    }

    const comments = response.data.map((comment) => {
      const attrs = comment.attributes;
      const creatorId = comment.relationships?.creator?.data?.id;
      const creatorName = creatorId ? includedPeople.get(creatorId) : undefined;

      let text = `[#${comment.id}] `;
      if (creatorName) {
        text += `${creatorName}: `;
      }
      text += attrs.body;
      text += `\n  Type: ${attrs.commentable_type}`;
      text += ` | ${attrs.hidden ? 'Hidden' : 'Visible'}`;
      text += ` | Created: ${attrs.created_at}`;
      if (attrs.edited_at) {
        text += ` | Edited: ${attrs.edited_at}`;
      }
      if (attrs.pinned_at) {
        text += ` | Pinned`;
      }
      if (attrs.draft) {
        text += ` | Draft`;
      }
      return text;
    });

    let result = `Comments (${response.data.length}`;
    if (response.meta?.total_count) {
      result += ` of ${response.meta.total_count}`;
    }
    result += `):\n\n${comments.join('\n\n')}`;

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

export const listCommentsDefinition = {
  name: 'list_comments',
  description: 'List comments from Productive.io. Filter by task, project, or discussion. Returns comment body, author, and metadata.',
  inputSchema: {
    type: 'object',
    properties: {
      task_id: {
        type: 'string',
        description: 'Filter comments by task ID',
      },
      project_id: {
        type: 'string',
        description: 'Filter comments by project ID',
      },
      discussion_id: {
        type: 'string',
        description: 'Filter comments by discussion ID',
      },
      draft: {
        type: 'boolean',
        description: 'Filter by draft status (true/false)',
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

// ---- Add Task Comment ----

const addTaskCommentSchema = z.object({
  task_id: z.string().min(1, 'Task ID is required'),
  comment: z.string().min(1, 'Comment text is required'),
  hidden: z.boolean().optional(),
});

export async function addTaskCommentTool(
  client: ProductiveAPIClient,
  args: unknown
): Promise<ToolResult> {
  try {
    const params = addTaskCommentSchema.parse(args);

    const commentData = {
      data: {
        type: 'comments' as const,
        attributes: {
          body: params.comment,
          ...(params.hidden !== undefined ? { hidden: params.hidden } : {}),
        },
        relationships: {
          task: {
            data: {
              id: params.task_id,
              type: 'tasks' as const,
            },
          },
        },
      },
    };

    const response = await client.createComment(commentData);

    let text = `Comment added successfully!\n`;
    text += `Task ID: ${params.task_id}\n`;
    text += `Comment: ${response.data.attributes.body}\n`;
    text += `Comment ID: ${response.data.id}`;
    text += `\nVisibility: ${response.data.attributes.hidden ? 'Hidden from client' : 'Visible to client'}`;
    if (response.data.attributes.created_at) {
      text += `\nCreated at: ${response.data.attributes.created_at}`;
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

export const addTaskCommentDefinition = {
  name: 'add_task_comment',
  description: 'Add a comment to a task in Productive.io. Supports HTML formatting. By default comments are hidden from client — set hidden=false to make visible.',
  inputSchema: {
    type: 'object',
    properties: {
      task_id: {
        type: 'string',
        description: 'ID of the task to add the comment to (required)',
      },
      comment: {
        type: 'string',
        description: 'Comment content (required). Supports HTML formatting with tags like <div>, <p>, <strong>, <em>, <ul>, <li>, <a href="">.',
      },
      hidden: {
        type: 'boolean',
        description: 'Whether the comment is hidden from the client. true = hidden (default), false = visible to client.',
      },
    },
    required: ['task_id', 'comment'],
  },
};

// ---- Get Comment ----

const getCommentSchema = z.object({
  comment_id: z.string().min(1, 'Comment ID is required'),
});

export async function getCommentTool(
  client: ProductiveAPIClient,
  args: unknown
): Promise<ToolResult> {
  try {
    const params = getCommentSchema.parse(args);

    const response = await client.getComment(params.comment_id);
    const comment = response.data;
    const attrs = comment.attributes;

    const creatorId = comment.relationships?.creator?.data?.id;
    const included = (response as unknown as { included?: ProductiveIncludedResource[] }).included;
    const creatorName = resolvePersonName(creatorId, included);

    let text = `Comment Details:\n\n`;
    text += `ID: ${comment.id}\n`;
    if (creatorName) {
      text += `Creator: ${creatorName} (ID: ${creatorId})\n`;
    } else if (creatorId) {
      text += `Creator ID: ${creatorId}\n`;
    }
    text += `Type: ${attrs.commentable_type}\n`;
    const taskId = comment.relationships?.task?.data?.id;
    if (taskId) text += `Task ID: ${taskId}\n`;
    text += `Visibility: ${attrs.hidden ? 'Hidden from client' : 'Visible to client'}\n`;
    text += `Created: ${attrs.created_at}\n`;
    if (attrs.edited_at) text += `Edited: ${attrs.edited_at}\n`;
    if (attrs.pinned_at) text += `Pinned: ${attrs.pinned_at}\n`;
    if (attrs.draft) text += `Draft: true\n`;
    if (attrs.deleted_at) text += `Deleted: ${attrs.deleted_at}\n`;
    if (attrs.reactions) text += `Reactions: ${JSON.stringify(attrs.reactions)}\n`;
    if (attrs.version_number !== undefined) text += `Version: ${attrs.version_number}\n`;
    text += `\n--- Body ---\n${attrs.body}`;

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

export const getCommentDefinition = {
  name: 'get_comment',
  description: 'Get a single comment by its ID from Productive.io. Returns the full body, creator, reactions, and metadata.',
  inputSchema: {
    type: 'object',
    properties: {
      comment_id: {
        type: 'string',
        description: 'The ID of the comment to retrieve (required)',
      },
    },
    required: ['comment_id'],
  },
};

// ---- Update Comment ----

const updateCommentSchema = z.object({
  comment_id: z.string().min(1, 'Comment ID is required'),
  comment: z.string().optional(),
  hidden: z.boolean().optional(),
});

export async function updateCommentTool(
  client: ProductiveAPIClient,
  args: unknown
): Promise<ToolResult> {
  try {
    const params = updateCommentSchema.parse(args);

    if (!params.comment && params.hidden === undefined) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'At least one of comment or hidden must be provided'
      );
    }

    const response = await client.updateComment(params.comment_id, {
      data: {
        type: 'comments',
        id: params.comment_id,
        attributes: {
          ...(params.comment !== undefined ? { body: params.comment } : {}),
          ...(params.hidden !== undefined ? { hidden: params.hidden } : {}),
        },
      },
    });

    const attrs = response.data.attributes;
    let text = `Comment updated successfully!\n`;
    text += `Comment ID: ${response.data.id}\n`;
    if (params.comment !== undefined) text += `Body: ${attrs.body}\n`;
    text += `Visibility: ${attrs.hidden ? 'Hidden from client' : 'Visible to client'}\n`;
    if (attrs.edited_at) text += `Edited at: ${attrs.edited_at}\n`;
    else if (attrs.updated_at) text += `Updated at: ${attrs.updated_at}\n`;

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

export const updateCommentDefinition = {
  name: 'update_comment',
  description: 'Update an existing comment in Productive.io. Can change the body, toggle visibility (hidden), or both.',
  inputSchema: {
    type: 'object',
    properties: {
      comment_id: {
        type: 'string',
        description: 'The ID of the comment to update (required)',
      },
      comment: {
        type: 'string',
        description: 'New comment content. Supports HTML formatting.',
      },
      hidden: {
        type: 'boolean',
        description: 'Set visibility. true = hidden from client, false = visible to client.',
      },
    },
    required: ['comment_id'],
  },
};

// ---- Delete Comment ----

const deleteCommentSchema = z.object({
  comment_id: z.string().min(1, 'Comment ID is required'),
});

export async function deleteCommentTool(
  client: ProductiveAPIClient,
  args: unknown
): Promise<ToolResult> {
  try {
    const params = deleteCommentSchema.parse(args);

    await client.deleteComment(params.comment_id);

    return {
      content: [{
        type: 'text',
        text: `Comment ${params.comment_id} deleted successfully.`,
      }],
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

export const deleteCommentDefinition = {
  name: 'delete_comment',
  description: 'Delete a comment from Productive.io by its ID. This action cannot be undone.',
  inputSchema: {
    type: 'object',
    properties: {
      comment_id: {
        type: 'string',
        description: 'The ID of the comment to delete (required)',
      },
    },
    required: ['comment_id'],
  },
};

// ---- Pin Comment ----

const pinCommentSchema = z.object({
  comment_id: z.string().min(1, 'Comment ID is required'),
});

export async function pinCommentTool(
  client: ProductiveAPIClient,
  args: unknown
): Promise<ToolResult> {
  try {
    const params = pinCommentSchema.parse(args);
    await client.pinComment(params.comment_id);
    return {
      content: [{ type: 'text', text: `Comment ${params.comment_id} pinned successfully.` }],
    };
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new McpError(ErrorCode.InvalidParams, `Invalid parameters: ${error.errors.map(e => e.message).join(', ')}`);
    }
    throw new McpError(ErrorCode.InternalError, error instanceof Error ? error.message : 'Unknown error occurred');
  }
}

export const pinCommentDefinition = {
  name: 'pin_comment',
  description: 'Pin a comment in Productive.io so it appears prominently.',
  inputSchema: {
    type: 'object',
    properties: {
      comment_id: { type: 'string', description: 'The ID of the comment to pin (required)' },
    },
    required: ['comment_id'],
  },
};

// ---- Unpin Comment ----

const unpinCommentSchema = z.object({
  comment_id: z.string().min(1, 'Comment ID is required'),
});

export async function unpinCommentTool(
  client: ProductiveAPIClient,
  args: unknown
): Promise<ToolResult> {
  try {
    const params = unpinCommentSchema.parse(args);
    await client.unpinComment(params.comment_id);
    return {
      content: [{ type: 'text', text: `Comment ${params.comment_id} unpinned successfully.` }],
    };
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new McpError(ErrorCode.InvalidParams, `Invalid parameters: ${error.errors.map(e => e.message).join(', ')}`);
    }
    throw new McpError(ErrorCode.InternalError, error instanceof Error ? error.message : 'Unknown error occurred');
  }
}

export const unpinCommentDefinition = {
  name: 'unpin_comment',
  description: 'Unpin a previously pinned comment in Productive.io.',
  inputSchema: {
    type: 'object',
    properties: {
      comment_id: { type: 'string', description: 'The ID of the comment to unpin (required)' },
    },
    required: ['comment_id'],
  },
};

// ---- Add Comment Reaction ----

const addCommentReactionSchema = z.object({
  comment_id: z.string().min(1, 'Comment ID is required'),
  reaction: z.string().min(1, 'Reaction is required'),
});

export async function addCommentReactionTool(
  client: ProductiveAPIClient,
  args: unknown
): Promise<ToolResult> {
  try {
    const params = addCommentReactionSchema.parse(args);
    await client.addCommentReaction(params.comment_id, params.reaction);
    return {
      content: [{ type: 'text', text: `Reaction "${params.reaction}" added to comment ${params.comment_id} successfully.` }],
    };
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new McpError(ErrorCode.InvalidParams, `Invalid parameters: ${error.errors.map(e => e.message).join(', ')}`);
    }
    throw new McpError(ErrorCode.InternalError, error instanceof Error ? error.message : 'Unknown error occurred');
  }
}

export const addCommentReactionDefinition = {
  name: 'add_comment_reaction',
  description: 'Add a reaction (e.g. "like") to a comment in Productive.io.',
  inputSchema: {
    type: 'object',
    properties: {
      comment_id: { type: 'string', description: 'The ID of the comment to react to (required)' },
      reaction: { type: 'string', description: 'The reaction to add (e.g. "like", "heart", "thumbsup") (required)' },
    },
    required: ['comment_id', 'reaction'],
  },
};
