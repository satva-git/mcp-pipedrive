import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { PipedriveClient } from "./pipedrive-client.js";
import { logger } from "./utils/logger.js";
import { handleToolError } from "./utils/error-handler.js";
import { metricsCollector } from "./utils/metrics.js";
import { getDealTools } from "./tools/deals/index.js";
import { getPersonTools } from "./tools/persons/index.js";
import { getOrganizationTools } from "./tools/organizations/index.js";
import { getActivityTools } from "./tools/activities/index.js";
import { getFileTools } from "./tools/files/index.js";
import { getSearchTools } from "./tools/search/index.js";
import { getPipelineTools } from "./tools/pipelines/index.js";
import { getNoteTools } from "./tools/notes/index.js";
import { getFieldTools } from "./tools/fields/index.js";
import { getSystemTools } from "./tools/system/index.js";
import { getProductTools } from "./tools/products/index.js";
import { getLeadTools } from "./tools/leads/index.js";
import { getUserTools } from "./tools/users/index.js";
import { getRoleTools } from "./tools/roles/index.js";
import { getWebhookTools } from "./tools/webhooks/index.js";
import { getFilterTools } from "./tools/filters/index.js";
import { getProjectTools } from "./tools/projects/index.js";
import { getProjectTemplateTools } from "./tools/project-templates/index.js";
import { getGoalTools } from "./tools/goals/index.js";
import { getTaskTools } from "./tools/tasks/index.js";
import { getActivityTypeTools } from "./tools/activity-types/index.js";
import { getCallLogTools } from "./tools/call-logs/index.js";
import { getMailboxTools } from "./tools/mailbox/index.js";
import { getTeamsTools } from "./tools/teams/index.js";
import { getOrganizationRelationshipsTools } from "./tools/org-relationships/index.js";
import { getPermissionSetTools } from "./tools/permission-sets/index.js";
import { getChannelTools } from "./tools/channels/index.js";
import { getMeetingTools } from "./tools/meetings/index.js";
import { setupResources } from "./resources/index.js";
import { setupPrompts } from "./prompts/index.js";

interface Tool { name?: string; description: string; inputSchema: { type: string; properties: Record<string, unknown>; required?: readonly string[] | string[] }; handler: (args: unknown) => Promise<unknown>; }
function arrayToToolsObject(tools: Tool[]): Record<string, Tool> { return tools.reduce((acc, tool) => { if (tool.name) acc[tool.name] = tool; return acc; }, {} as Record<string, Tool>); }
function isWriteOperation(n: string): boolean { return ["/create","_create","/update","_update","/delete","_delete","/add_","_add_","/remove_","_remove_","/upload","_upload","/duplicate","_duplicate","/mark_","_mark_","/attach_","_attach_","/move_","_move_"].some(p => n.includes(p)); }

export interface ServerOptions { apiToken: string; readOnly?: boolean; enabledToolsets?: string[] }
const DEFAULT_TOOLSETS = ["deals","persons","organizations","activities","files","search","pipelines","notes","fields","system","products","leads","users","roles","webhooks","filters","projects","project_templates","goals","tasks","activity_types","call_logs","mailbox","teams","org_relationships","permission_sets","channels","meetings"];

export function createPipedriveServer(options: ServerOptions): Server {
  const { apiToken, readOnly = false, enabledToolsets = DEFAULT_TOOLSETS } = options;
  const client = new PipedriveClient(apiToken);
  const allTools: Record<string, Tool> = {
    ...getDealTools(client),
    ...arrayToToolsObject(getPersonTools(client)),
    ...arrayToToolsObject(getOrganizationTools(client)),
    ...arrayToToolsObject(getActivityTools(client)),
    ...getFileTools(client),
    ...getSearchTools(client),
    ...getPipelineTools(client),
    ...getNoteTools(client),
    ...getFieldTools(client),
    ...getSystemTools(client),
    ...arrayToToolsObject(getProductTools(client)),
    ...getLeadTools(client),
    ...getUserTools(client),
    ...getRoleTools(client),
    ...getWebhookTools(client),
    ...getFilterTools(client),
    ...arrayToToolsObject(getProjectTools(client)),
    ...arrayToToolsObject(getProjectTemplateTools(client)),
    ...getGoalTools(client),
    ...getTaskTools(client),
    ...getActivityTypeTools(client),
    ...getCallLogTools(client),
    ...arrayToToolsObject(getMailboxTools(client)),
    ...arrayToToolsObject(getTeamsTools(client)),
    ...arrayToToolsObject(getOrganizationRelationshipsTools(client)),
    ...getPermissionSetTools(client),
    ...getChannelTools(client),
    ...getMeetingTools(client)
  };
  const tools = Object.fromEntries(Object.entries(allTools).filter(([name]) => { const ts = name.split(/[/_]/)[0]; if (!enabledToolsets.includes(ts)) return false; if (readOnly && isWriteOperation(name)) return false; return true; }));
  const server = new Server({ name: "pipedrive-mcp", version: "0.0.0-development" }, { capabilities: { tools: {}, resources: {}, prompts: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: Object.entries(tools).map(([name, tool]) => ({ name, description: tool.description, inputSchema: tool.inputSchema })) }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    logger.info("Tool called", { tool: name, hasArgs: !!args });
    const startTime = Date.now();
    let success = true;
    try {
      const tool = tools[name];
      if (!tool) throw new Error("Unknown tool: " + name);
      const result = await tool.handler(args || {});
      logger.info("Tool executed", { tool: name, duration: Date.now() - startTime });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      success = false;
      const dur = Date.now() - startTime;
      logger.error("Tool failed", error as Error, { tool: name, duration: dur });
      metricsCollector.recordRequest(name, dur, true);
      return handleToolError(error);
    } finally {
      if (success) metricsCollector.recordRequest(name, Date.now() - startTime, false);
    }
  });
  setupResources(server, client);
  setupPrompts(server);
  logger.info("Server created", { toolCount: Object.keys(tools).length, enabledToolsets, readOnly });
  return server;
}