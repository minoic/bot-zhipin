import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const username = process.env.MCP_BOT_USERNAME ?? 'MCPBotTest';
const client = new Client({ name: 'minecraft-mcp-smoke', version: '1.0.0' }, { capabilities: {} });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [
    'node_modules/minecraft-mcp-server/dist/main.js',
    '--host',
    '127.0.0.1',
    '--port',
    '25565',
    '--username',
    username,
  ],
  cwd: process.cwd(),
  stderr: 'inherit',
});

try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  if (!tools.some((tool) => tool.name === 'get-position')) {
    throw new Error('get-position was not registered');
  }

  await new Promise((resolve) => setTimeout(resolve, 7000));
  const result = await client.callTool({ name: 'get-position', arguments: {} });
  if (!Array.isArray(result.content)) {
    throw new Error('get-position returned no content array');
  }
  const responseText = result.content
    .flatMap((item) => {
      if (
        typeof item === 'object' &&
        item !== null &&
        'type' in item &&
        item.type === 'text' &&
        'text' in item &&
        typeof item.text === 'string'
      ) {
        return [item.text];
      }
      return [];
    })
    .join('\n');

  if (result.isError || !/Current position: \(-?\d+, -?\d+, -?\d+\)/.test(responseText)) {
    throw new Error(`get-position failed: ${responseText}`);
  }

  console.log(JSON.stringify({ username, tools: tools.length, getPosition: responseText }));
} finally {
  await client.close();
}
