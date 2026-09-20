export type McpConnection = { id: string; clientId: string; name: string; scopes: string[] };
export type McpConnectionsResponse = { items: McpConnection[]; nextCursor: string | null };
