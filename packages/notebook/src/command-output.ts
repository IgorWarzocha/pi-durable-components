// Adapted from pi-codex-conversion at b2006db9def12c373ae48e70044d30f7d6b7e34f, MIT. See ../NOTICE.
export const commandOutputFormatterSource = `(value, plain) => {
  const metadata = Object.fromEntries(Object.entries(value).filter(([key]) =>
    key !== "output" && key !== "chunk_id" && key !== "wall_time_seconds"
    && (key !== "original_token_count" || value.truncated)));
  const projected = plain ? metadata : { output: value.output, ...metadata };
  let text;
  try { text = JSON.stringify(projected); } catch { text = String(projected); }
  return plain ? text + "\\nOutput:\\n" + value.output : text;
}`;
