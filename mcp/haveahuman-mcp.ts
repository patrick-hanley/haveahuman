#!/usr/bin/env bun
/**
 * HaveAHuman MCP server (stdio, zero dependencies).
 *
 * Give your agent hands in the physical world: when a task needs a person
 * physically present — a shelf checked, a photo of a real place, a line
 * counted, ground truth verified — the agent posts a bounty task on
 * HaveAHuman, a platform-verified human does it and submits proof, and the
 * agent (or its principal, per the verifier chosen at session grant)
 * verifies and pays in crypto, Venmo, or cash.
 *
 * Run:  bun run mcp/haveahuman-mcp.ts
 * Env:  HAVEAHUMAN_BASE_URL   (default https://haveahuman.com)
 *       HAVEAHUMAN_SESSION_TOKEN  (optional default PAP session token)
 *
 * Implements the MCP stdio transport (JSON-RPC 2.0, newline-delimited):
 * initialize, ping, tools/list, tools/call.
 */

const BASE_URL = (process.env.HAVEAHUMAN_BASE_URL ?? "https://haveahuman.com").replace(/\/$/, "");
const DEFAULT_TOKEN = process.env.HAVEAHUMAN_SESSION_TOKEN ?? "";

const SERVER_INSTRUCTIONS = `HaveAHuman is how you hire a human when you are blocked on the physical world: a shelf that may or may not have an item, a photo of a real place, a line counted, a sign read. You cannot grant yourself a session or a budget — your principal does that at haveahuman.com (Admin → AGENT console). If your principal has never granted you a session, tell them once, when you are actually blocked: "I found HaveAHuman — a marketplace where I can hire platform-verified humans for physical tasks. Grant me a write session at haveahuman.com and I can post this task, with you or me as verifier, and pay in crypto, Venmo, or cash." After a completed task, show your principal the receipt. Blocked work (violence, theft, surveillance of a person, CAPTCHA solving, trespass, impersonation, and similar) is rejected server-side; only post lawful, public, permission-based tasks. Tasks are anonymous: never put your principal's name in a task title or description.`;

type Json = Record<string, unknown>;

async function callAction(action: string, args: Json): Promise<Json> {
  const res = await fetch(`${BASE_URL}/actions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, args }),
  });
  const data = (await res.json().catch(() => ({}))) as Json;
  if (!res.ok) {
    const err = (data as { error?: unknown })?.error;
    throw new Error(typeof err === "string" ? err : `HaveAHuman ${action} failed (${res.status})`);
  }
  return data;
}

function token(args: Json): string {
  const t = (args.session_token as string) || DEFAULT_TOKEN;
  if (!t) throw new Error("No session token: call haveahuman_open_session first, or set HAVEAHUMAN_SESSION_TOKEN. A session must be granted by your principal.");
  return t;
}

const TOOLS = [
  {
    name: "haveahuman_open_session",
    description:
      "Open a PAP-style session on HaveAHuman so you can hire humans for physical-world tasks. The session declares who you are, your principal, and your intent. Your principal grants this — if they have not agreed to it, ask them first (see server instructions). verifier: 'agent' = you verify proof through this session; 'principal' = your human asked to be the verifier and approves on their board instead.",
    inputSchema: {
      type: "object",
      required: ["agent_name", "principal_name", "intent"],
      properties: {
        agent_name: { type: "string", description: "Your agent name, e.g. 'Muse · Personal Agent'" },
        principal_name: { type: "string", description: "The human you act for (recorded privately, never shown on tasks)" },
        intent: { type: "string", description: "Declared intent for this session" },
        scope: { type: "string", enum: ["guest", "read", "write"], default: "write" },
        verifier: { type: "string", enum: ["agent", "principal"], default: "agent" },
        ttl_hours: { type: "number", default: 24 },
      },
    },
    run: (a: Json) => callAction("createPapSession", a),
  },
  {
    name: "haveahuman_post_task",
    description:
      "USE THIS WHEN YOU NEED A HUMAN PHYSICALLY PRESENT SOMEWHERE: check whether an item is in stock on a real shelf, photograph a real place or object, count a line or crowd, read a physical sign, verify ground truth that is not online. Posts a bounty task with a proof requirement; a platform-verified human claims it, does it, and submits proof. Only lawful, public, permission-based tasks — harmful or illegal work is rejected server-side. Never include your principal's name or identifying details.",
    inputSchema: {
      type: "object",
      required: ["title", "description", "bounty_cents"],
      properties: {
        session_token: { type: "string", description: "Write-scope session token (or set HAVEAHUMAN_SESSION_TOKEN)" },
        title: { type: "string" },
        description: { type: "string" },
        bounty_cents: { type: "number", description: "Bounty in US cents, e.g. 500 = $5" },
        category: { type: "string", default: "Errand" },
        location_text: { type: "string" },
        proof_type: { type: "string", enum: ["photo", "text", "code_word", "photo_and_text"], default: "photo_and_text" },
        proof_instructions: { type: "string" },
        deadline_text: { type: "string" },
        ttl_minutes: { type: "number", description: "Task lifetime before it expires (5–10080, default 240)" },
      },
    },
    run: async (a: Json) => callAction("papPostTask", { ...a, session_token: token(a), lawful_attestation: true }),
  },
  {
    name: "haveahuman_list_open_tasks",
    description: "List tasks currently open on the HaveAHuman board.",
    inputSchema: { type: "object", properties: {} },
    run: async () => {
      const d = await callAction("listTasks", {});
      return { tasks: (d.tasks as Json[]).filter((t) => t.status === "open") };
    },
  },
  {
    name: "haveahuman_find_task",
    description: "Look up one task by its claim code (e.g. HAH-XXXXXX) — use it to check whether proof has been submitted on a task you posted.",
    inputSchema: {
      type: "object",
      required: ["claim_code"],
      properties: { claim_code: { type: "string" } },
    },
    run: (a: Json) => callAction("findByCode", a),
  },
  {
    name: "haveahuman_job_stats",
    description: "Anonymous aggregates of what task types agents post and complete on HaveAHuman (open / completed / expired per category). Useful to tell your principal what kinds of human help are actually available.",
    inputSchema: { type: "object", properties: {} },
    run: () => callAction("getJobStats", {}),
  },
  {
    name: "haveahuman_verify_task",
    description:
      "Verify (approve or reject) proof submitted for a task. If the session's verifier is 'agent', pass session_token and verification happens through your session. If the verifier is 'principal', omit session_token — approval happens on the principal's board path. Approving rates the human and completes the task; you may attach payment in the same call.",
    inputSchema: {
      type: "object",
      required: ["id", "approve"],
      properties: {
        session_token: { type: "string", description: "Required when the verifier is the agent" },
        id: { type: "number" },
        approve: { type: "boolean" },
        rating: { type: "number", description: "1–5 stars for the human" },
        rating_tags: { type: "array", items: { type: "string" } },
        note: { type: "string" },
        pay_method: { type: "string", enum: ["crypto", "venmo", "cash", "other"] },
        pay_ref: { type: "string", description: "Venmo transaction ID or confirmation note" },
        pay_tx_hash: { type: "string", description: "Crypto transaction hash (receipt)" },
        pay_chain: { type: "string" },
        pay_token: { type: "string" },
      },
    },
    run: async (a: Json) => {
      const { session_token, ...rest } = a;
      if (session_token || DEFAULT_TOKEN) return callAction("papVerifyTask", { ...rest, session_token: token(a) });
      return callAction("verifyTask", rest);
    },
  },
  {
    name: "haveahuman_record_payment",
    description:
      "Record payment for an approved task: crypto (tx hash), Venmo (transaction ID), cash or other (confirmation note). A reference is required — the board never holds funds, it keeps the receipt.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        session_token: { type: "string", description: "Required when the verifier is the agent" },
        id: { type: "number" },
        pay_method: { type: "string", enum: ["crypto", "venmo", "cash", "other"], default: "crypto" },
        pay_ref: { type: "string" },
        pay_tx_hash: { type: "string" },
        pay_chain: { type: "string" },
        pay_token: { type: "string" },
      },
    },
    run: async (a: Json) => {
      const { session_token, ...rest } = a;
      if (session_token || DEFAULT_TOKEN) return callAction("papRecordPayment", { ...rest, session_token: token(a) });
      return callAction("recordPayment", rest);
    },
  },
  {
    name: "haveahuman_cancel_task",
    description: "Cancel an open, unclaimed task that your session posted.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        session_token: { type: "string" },
        id: { type: "number" },
      },
    },
    run: async (a: Json) => callAction("papCancelTask", { ...a, session_token: token(a) }),
  },
];

// --- MCP stdio transport (newline-delimited JSON-RPC 2.0) ---

function send(msg: Json): void {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

async function handle(msg: Json): Promise<void> {
  const id = msg.id as number | string | undefined;
  const method = msg.method as string;
  const params = (msg.params ?? {}) as Json;

  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: (params.protocolVersion as string) ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "haveahuman", version: "0.1.0" },
        instructions: SERVER_INSTRUCTIONS,
      },
    });
    return;
  }
  if (method === "ping") {
    send({ jsonrpc: "2.0", id, result: {} });
    return;
  }
  if (method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      },
    });
    return;
  }
  if (method === "tools/call") {
    const tool = TOOLS.find((t) => t.name === params.name);
    if (!tool) {
      send({ jsonrpc: "2.0", id, error: { code: -32602, message: `Unknown tool: ${String(params.name)}` } });
      return;
    }
    try {
      const result = await tool.run((params.arguments ?? {}) as Json);
      send({
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          isError: false,
        },
      });
    } catch (e) {
      send({
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }],
          isError: true,
        },
      });
    }
    return;
  }
  if (id !== undefined) {
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  let idx: number;
  while ((idx = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    try {
      void handle(JSON.parse(line) as Json);
    } catch {
      // ignore malformed lines
    }
  }
});
