/** Scoped tokens. Hosts may override them without installing global page styles. */
export const themeCss = `
[data-durable-ui] {
  color-scheme: light dark;
  --durable-ui-background: #fff;
  --durable-ui-foreground: #24292f;
  --durable-ui-muted: #57606a;
  --durable-ui-border: #d0d7de;
  --durable-ui-accent: #0969da;
  color: var(--durable-ui-foreground);
  background: var(--durable-ui-background);
}
@media (prefers-color-scheme: dark) {
  [data-durable-ui]:not([data-theme="light"]) {
    --durable-ui-background: #161b22;
    --durable-ui-foreground: #e6edf3;
    --durable-ui-muted: #9da7b3;
    --durable-ui-border: #444c56;
    --durable-ui-accent: #79c0ff;
  }
}
[data-durable-ui][data-theme="dark"] {
  --durable-ui-background: #161b22;
  --durable-ui-foreground: #e6edf3;
  --durable-ui-muted: #9da7b3;
  --durable-ui-border: #444c56;
  --durable-ui-accent: #79c0ff;
}
[data-durable-ui] :focus-visible { outline: 2px solid var(--durable-ui-accent); outline-offset: 3px; }
`;
