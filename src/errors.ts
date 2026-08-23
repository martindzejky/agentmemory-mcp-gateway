export const GENERIC_AUTH_ERROR = "Invalid email or password";
export const GENERIC_FORBIDDEN = "Request denied";
export const UPSTREAM_UNAVAILABLE = "Memory service is unavailable";
export const UPSTREAM_INVALID = "Memory service returned an invalid response";
export const TOOL_NOT_ALLOWED = "Tool is not available";

export function mcpToolError(message: string): {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
} {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}
