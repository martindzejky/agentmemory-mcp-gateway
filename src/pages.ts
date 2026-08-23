import { html } from "hono/html";
import { GENERIC_AUTH_ERROR } from "./errors.js";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function layout(title: string, body: unknown) {
  return html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${title}</title>
        <style>
          :root {
            color-scheme: light dark;
          }
          body {
            font-family: ui-sans-serif, system-ui, sans-serif;
            max-width: 28rem;
            margin: 4rem auto;
            padding: 0 1rem;
            line-height: 1.5;
          }
          label,
          button {
            display: block;
            width: 100%;
          }
          input {
            width: 100%;
            margin: 0.25rem 0 1rem;
            padding: 0.5rem;
          }
          button {
            padding: 0.6rem 0.75rem;
            cursor: pointer;
          }
          .error {
            color: #b42318;
            margin-bottom: 1rem;
          }
          .actions {
            display: flex;
            gap: 0.75rem;
          }
        </style>
      </head>
      <body>
        ${body}
      </body>
    </html>`;
}

export function loginPage(query: string, error = false) {
  return layout(
    "Sign in",
    html`
      <h1>Sign in</h1>
      <p>Authorize this MCP client with the single administrator account.</p>
      ${error ? html`<p class="error">${GENERIC_AUTH_ERROR}</p>` : ""}
      <form method="post" action="/sign-in?${query}">
        <label>
          Email
          <input type="email" name="email" autocomplete="username" required />
        </label>
        <label>
          Password
          <input type="password" name="password" autocomplete="current-password" required />
        </label>
        <button type="submit">Continue</button>
      </form>
    `,
  );
}

export function consentPage(input: { query: string; clientId: string; scope: string }) {
  return layout(
    "Authorize client",
    html`
      <h1>Authorize MCP client</h1>
      <p>A remote MCP client wants access to this personal memory gateway.</p>
      <p><strong>Client:</strong> ${escapeHtml(input.clientId || "unknown")}</p>
      <p><strong>Scopes:</strong> ${escapeHtml(input.scope || "none requested")}</p>
      <div class="actions">
        <form method="post" action="/consent?${input.query}">
          <input type="hidden" name="accept" value="true" />
          <button type="submit">Allow</button>
        </form>
        <form method="post" action="/consent?${input.query}">
          <input type="hidden" name="accept" value="false" />
          <button type="submit">Deny</button>
        </form>
      </div>
    `,
  );
}
