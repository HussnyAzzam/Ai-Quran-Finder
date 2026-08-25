import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new Server(
  { name: "sample-mcp-server", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// Expose tools to the LLM Client
server.setRequestHandler("tools/list", async () => ({
  tools: [
    {
      name: "get_weather",
      description: "Get the current weather for a specific city.",
      inputSchema: {
        type: "object",
        properties: {
          city: { type: "string", description: "The city to look up, e.g., London, Tokyo" }
        },
        required: ["city"]
      }
    }
  ]
}));

// Process tool calling execution
server.setRequestHandler("tools/call", async (request) => {
  if (request.params.name === "get_weather") {
    const city = request.params.arguments?.city || "unknown location";
    return {
      content: [{ type: "text", text: `The weather in ${city} is currently sunny and 22°C.` }]
    };
  }
  throw new Error("Tool not found");
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("MCP Server running via stdio");
