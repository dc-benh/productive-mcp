import { Config } from '../config/index.js';
import { Schema, Node as PMNode, Slice } from 'prosemirror-model';
import { ReplaceStep } from 'prosemirror-transform';

const COLLAB_BASE_URL = 'https://docs-realtime.productive.io';
const COLLAB_FEATURE_FLAGS = 'timeout,jwt-auth,enable-steps-on-save,enable-version-number,unloaded-with-unsaved-changes,api-prosemirror-body';

/**
 * Node type mapping: REST API schema → Collab server schema.
 */
const NODE_TYPE_TO_COLLAB: Record<string, string> = {
  horizontal_rule: 'divider',
  hard_break: 'br',
};

/** Recursively normalise ProseMirror node types to the collab server schema. */
export function normaliseNodeTypes(node: any): any {
  if (!node || typeof node !== 'object') return node;
  const mapped = { ...node };
  if (mapped.type && NODE_TYPE_TO_COLLAB[mapped.type]) {
    mapped.type = NODE_TYPE_TO_COLLAB[mapped.type];
  }
  if (Array.isArray(mapped.content)) {
    mapped.content = mapped.content.map(normaliseNodeTypes);
  }
  return mapped;
}

/**
 * ProseMirror schema matching Productive's collab server.
 * Built from observed node types in real Productive documents.
 */
const productiveSchema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: {
      group: 'block',
      content: 'inline*',
      attrs: { id: { default: null }, horizontalAlign: { default: null } },
    },
    heading: {
      group: 'block',
      content: 'inline*',
      attrs: { level: { default: 1 }, id: { default: null }, horizontalAlign: { default: null } },
      defining: true,
    },
    divider: { group: 'block', atom: true, attrs: { id: { default: null } } },
    br: { group: 'inline', inline: true, atom: true },
    banner: {
      group: 'block',
      content: 'block+',
      attrs: { id: { default: null }, type: { default: 'info' } },
    },
    checklist: {
      group: 'block',
      content: 'checklist_item+',
      attrs: { id: { default: null } },
    },
    checklist_item: {
      content: 'paragraph block*',
      attrs: { checked: { default: 'false' } },
    },
    ul: {
      group: 'block',
      content: 'li+',
      attrs: { id: { default: null } },
    },
    ol: {
      group: 'block',
      content: 'li+',
      attrs: { id: { default: null }, start: { default: 1 } },
    },
    li: { content: 'paragraph block*' },
    table: {
      group: 'block',
      content: 'table_row+',
      attrs: { id: { default: null } },
      tableRole: 'table',
    },
    table_row: {
      content: '(table_cell | table_header)+',
      tableRole: 'row',
    },
    table_header: {
      content: 'block+',
      attrs: {
        colspan: { default: 1 }, rowspan: { default: 1 },
        colwidth: { default: null }, background: { default: null },
        horizontalAlign: { default: null }, verticalAlign: { default: null },
      },
      tableRole: 'header_cell',
    },
    table_cell: {
      content: 'block+',
      attrs: {
        colspan: { default: 1 }, rowspan: { default: 1 },
        colwidth: { default: null }, background: { default: null },
        horizontalAlign: { default: null }, verticalAlign: { default: null },
      },
      tableRole: 'cell',
    },
    mention: {
      group: 'inline',
      inline: true,
      content: 'text*',
      attrs: {
        id: { default: null }, type: { default: null }, label: { default: null },
        avatarUrl: { default: null }, isDone: { default: false }, isRootPage: { default: false },
      },
    },
    text: { group: 'inline' },
  },
  marks: {
    strong: {},
    em: {},
    code: {},
    underline: {},
    strike: {},
    link: { attrs: { href: { default: '' }, title: { default: null } } },
    styles: {
      attrs: {
        fontSize: { default: '' }, fontWeight: { default: '' }, textAlign: { default: '' },
        color: { default: '' }, backgroundColor: { default: '' }, whiteSpace: { default: '' },
      },
    },
  },
});

function randomClientId(): string {
  return 'mcp-' + Math.random().toString(36).substring(2, 12);
}

/** Get a JWT scoped to a root page for the collab server. */
async function getCollabJwt(config: Config, rootPageId: string): Promise<string> {
  const url = `${config.PRODUCTIVE_API_BASE_URL}pages/${rootPageId}/jwt?expires_in=1800`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'X-Auth-Token': config.PRODUCTIVE_API_TOKEN,
      'X-Organization-Id': config.PRODUCTIVE_ORG_ID,
      'Content-Type': 'application/vnd.api+json',
    },
  });
  if (!res.ok) {
    throw new Error(`JWT request failed: ${res.status} ${await res.text().catch(() => '')}`);
  }
  const data = await res.json();
  const token = data?.jwt ?? data?.token ?? data?.data?.attributes?.token ?? data?.data?.token;
  if (!token || typeof token !== 'string') {
    throw new Error(`Unexpected JWT response: ${JSON.stringify(data).substring(0, 200)}`);
  }
  return token;
}

/** Fetch the collab server's current document state and version. */
async function getCollabState(
  config: Config,
  pageId: string,
  jwt: string
): Promise<{ doc: PMNode; version: number }> {
  const headers: Record<string, string> = {
    'X-Auth-Token': jwt,
    'X-Organization-Id': config.PRODUCTIVE_ORG_ID,
    'X-Feature-Flags': COLLAB_FEATURE_FLAGS,
  };

  const bodyRes = await fetch(`${COLLAB_BASE_URL}/pages/${pageId}`, { headers });
  if (bodyRes.status === 404) {
    throw new NotCollabError('no collab session');
  }
  if (!bodyRes.ok) {
    const text = await bodyRes.text().catch(() => '');
    throw new Error(`Collab state fetch failed: ${bodyRes.status} ${text.substring(0, 200)}`);
  }
  const data = await bodyRes.json();
  const docJson = data?.doc ?? data;
  const version = data?.version ?? 0;

  const doc = PMNode.fromJSON(productiveSchema, docJson);
  return { doc, version };
}

/** Post ProseMirror steps to the collab server. */
async function postCollabSteps(
  config: Config,
  pageId: string,
  jwt: string,
  payload: { version: number; steps: any[]; clientId: string; personId: string }
): Promise<void> {
  const body = {
    ...payload,
    anchor: 1,
    head: 1,
    timestamp: Date.now(),
  };

  const res = await fetch(`${COLLAB_BASE_URL}/pages/${pageId}/events`, {
    method: 'POST',
    headers: {
      'X-Auth-Token': jwt,
      'X-Organization-Id': config.PRODUCTIVE_ORG_ID,
      'X-Feature-Flags': COLLAB_FEATURE_FLAGS,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Collab POST failed: ${res.status} ${text.substring(0, 300)}`);
  }
}

class NotCollabError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'NotCollabError';
  }
}

/**
 * Sync a page body update to the collab server.
 *
 * Uses prosemirror-transform to compute a valid ReplaceStep that the collab
 * server's ProseMirror instance will accept. This handles complex documents
 * with tables, checklists, banners, mentions, etc.
 *
 * Best-effort: returns a warning string on failure, null on success.
 */
export async function syncPageToCollab(
  config: Config,
  pageId: string,
  rootPageId: string,
  newBodyJson: string
): Promise<string | null> {
  if (!config.PRODUCTIVE_USER_ID) {
    return 'Collab sync skipped: PRODUCTIVE_USER_ID not configured.';
  }

  try {
    // Parse and normalise the new body
    let newDocJson: any;
    try {
      newDocJson = JSON.parse(newBodyJson);
    } catch {
      return null; // Non-JSON body — can't sync
    }
    if (!newDocJson?.content) {
      return null;
    }
    newDocJson = normaliseNodeTypes(newDocJson);

    // Parse into a proper ProseMirror Node using our schema
    let newDoc: PMNode;
    try {
      newDoc = PMNode.fromJSON(productiveSchema, newDocJson);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return `Collab sync skipped: cannot parse body into ProseMirror schema: ${msg}`;
    }

    // Step 1: Get JWT scoped to the root page
    const jwt = await getCollabJwt(config, rootPageId);

    // Step 2: Get collab server's current state as a ProseMirror Node
    let collabDoc: PMNode;
    let collabVersion: number;
    try {
      const collab = await getCollabState(config, pageId, jwt);
      collabDoc = collab.doc;
      collabVersion = collab.version;
    } catch (e) {
      if (e instanceof NotCollabError) {
        return null; // No collab session — REST API update is sufficient
      }
      throw e;
    }

    // Step 3: Compute a valid ReplaceStep using prosemirror-transform
    // Replace the entire doc content (position 0 to content.size)
    // Slice with openStart=0, openEnd=0 means a closed slice at the doc level
    const step = new ReplaceStep(
      0,
      collabDoc.content.size,
      new Slice(newDoc.content, 0, 0),
    );

    // Validate the step locally before sending
    const result = step.apply(collabDoc);
    if (result.failed) {
      return `Collab sync skipped: step validation failed: ${result.failed}`;
    }

    // Step 4: Post to collab server
    await postCollabSteps(config, pageId, jwt, {
      version: collabVersion,
      steps: [step.toJSON()],
      clientId: randomClientId(),
      personId: config.PRODUCTIVE_USER_ID,
    });

    return null; // success
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return `Collab sync warning: ${msg}`;
  }
}
