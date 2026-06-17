import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { config } from './config.js';
import chalk from 'chalk';

const mcpClients = new Map();
const mcpTools = new Map();

export async function initMcpServers(p) {
  if (!config.mcpServers || Object.keys(config.mcpServers).length === 0) {
    return;
  }

  p.log.info(chalk.dim('Initializing MCP servers...'));

  for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
    try {
      const transport = new StdioClientTransport({
        command: serverConfig.command,
        args: serverConfig.args,
        env: { ...process.env, ...(serverConfig.env || {}) }
      });
      
      const client = new Client({
        name: "ai-cli",
        version: "1.0.0"
      }, {
        capabilities: { tools: {} }
      });

      await client.connect(transport);
      mcpClients.set(name, client);

      const toolsRes = await client.listTools();
      let added = 0;
      for (const tool of toolsRes.tools) {
        const prefixedName = `${name}__${tool.name}`;
        const def = {
          type: 'function',
          function: {
            name: prefixedName,
            description: tool.description || '',
            parameters: tool.inputSchema || { type: 'object', properties: {} }
          }
        };
        mcpTools.set(prefixedName, { definition: def, clientName: name, originalName: tool.name });
        added++;
      }
      p.log.step(chalk.dim(`Connected to MCP server "${name}" (${added} tools)`));
    } catch (err) {
      p.log.warn(`Failed to connect to MCP server "${name}": ${err.message}`);
    }
  }
}

export function getMcpToolDefinitions() {
  return Array.from(mcpTools.values()).map(t => t.definition);
}

export function isMcpTool(name) {
  return mcpTools.has(name);
}

export async function executeMcpTool(name, args) {
  const toolInfo = mcpTools.get(name);
  if (!toolInfo) return { error: `MCP Tool not found: ${name}` };
  
  const client = mcpClients.get(toolInfo.clientName);
  if (!client) return { error: `MCP Client not found: ${toolInfo.clientName}` };

  try {
    const result = await client.callTool({
      name: toolInfo.originalName,
      arguments: args
    });
    
    if (result.isError) {
       return { error: result.content.map(c => c.text).join('\n') };
    }
    return { content: result.content.map(c => c.text).join('\n') };
  } catch (err) {
    return { error: `MCP Tool execution failed: ${err.message}` };
  }
}

export function cleanupMcpServers() {
  for (const client of mcpClients.values()) {
    try {
       client.transport?.close?.();
    } catch {}
  }
}
