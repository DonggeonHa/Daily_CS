const { marked } = require("marked");

const ALLOWED_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, "&#96;");
}

function decodeEntity(entity) {
  const named = { amp: "&", colon: ":", lt: "<", gt: ">", quot: "\"", apos: "'" };
  const lower = entity.toLowerCase();
  if (Object.hasOwn(named, lower)) return named[lower];
  if (lower.startsWith("#x")) {
    const code = Number.parseInt(lower.slice(2), 16);
    return Number.isFinite(code) ? String.fromCodePoint(code) : `&${entity};`;
  }
  if (lower.startsWith("#")) {
    const code = Number.parseInt(lower.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : `&${entity};`;
  }
  return `&${entity};`;
}

function decodeHtmlEntities(value) {
  return String(value ?? "").replace(/&([a-zA-Z][a-zA-Z0-9]+|#[0-9]+|#[xX][0-9a-fA-F]+);?/g, (_match, entity) => decodeEntity(entity));
}

function safeHref(value) {
  const href = String(value ?? "").trim();
  if (!href) return "";
  const decoded = decodeHtmlEntities(href).replace(/[\u0000-\u001F\u007F\s]+/g, "");
  try {
    const url = new URL(decoded, "https://daily-cs.invalid/");
    if (!ALLOWED_PROTOCOLS.has(url.protocol)) return "";
    return href;
  } catch {
    return "";
  }
}

function inlineTokens(token) {
  if (Array.isArray(token?.tokens)) return token.tokens;
  const text = token?.text ?? token?.raw ?? "";
  return marked.lexer.inlineTokens(String(text));
}

function renderInlineToken(token) {
  switch (token.type) {
    case "escape":
    case "text":
      return escapeHtml(token.text ?? token.raw);
    case "codespan":
      return `<code>${escapeHtml(token.text)}</code>`;
    case "strong":
      return `<strong>${renderInlineTokens(inlineTokens(token))}</strong>`;
    case "em":
      return `<em>${renderInlineTokens(inlineTokens(token))}</em>`;
    case "br":
      return "<br>";
    case "del":
      return `<span>${renderInlineTokens(inlineTokens(token))}</span>`;
    case "link": {
      const label = renderInlineTokens(inlineTokens(token));
      const href = safeHref(token.href);
      if (!href) return label;
      const target = /^https?:/i.test(decodeHtmlEntities(href).trim()) ? ' target="_blank"' : "";
      return `<a href="${escapeAttr(href)}" rel="noopener noreferrer"${target}>${label}</a>`;
    }
    case "image":
      return escapeHtml(token.text ?? "");
    case "html":
      return escapeHtml(token.raw ?? token.text);
    default:
      return escapeHtml(token.text ?? token.raw ?? "");
  }
}

function renderInlineTokens(tokens) {
  return (tokens ?? []).map(renderInlineToken).join("");
}

function renderList(token) {
  const tag = token.ordered ? "ol" : "ul";
  const items = (token.items ?? []).map((item) => {
    const body = item.tokens?.length
      ? renderBlockTokens(item.tokens)
      : renderInlineTokens(inlineTokens(item));
    return `<li>${body}</li>`;
  }).join("");
  return `<${tag}>${items}</${tag}>`;
}

function renderTable(token) {
  const header = (token.header ?? []).map((cell) => `<th scope="col">${renderInlineTokens(inlineTokens(cell))}</th>`).join("");
  const rows = (token.rows ?? []).map((row) => {
    const cells = row.map((cell) => `<td>${renderInlineTokens(inlineTokens(cell))}</td>`).join("");
    return `<tr>${cells}</tr>`;
  }).join("");
  return `<table><thead><tr>${header}</tr></thead><tbody>${rows}</tbody></table>`;
}

function renderBlockToken(token) {
  switch (token.type) {
    case "space":
      return "";
    case "heading": {
      const depth = Math.min(Math.max(Number(token.depth) || 2, 1), 6);
      return `<h${depth}>${renderInlineTokens(inlineTokens(token))}</h${depth}>`;
    }
    case "paragraph":
      return `<p>${renderInlineTokens(inlineTokens(token))}</p>`;
    case "blockquote":
      return `<blockquote>${renderBlockTokens(token.tokens ?? [])}</blockquote>`;
    case "list":
      return renderList(token);
    case "code":
      return `<pre><code>${escapeHtml(token.text)}</code></pre>`;
    case "hr":
      return "<hr>";
    case "table":
      return renderTable(token);
    case "html":
      return `<p>${escapeHtml(token.raw ?? token.text)}</p>`;
    case "text":
      return `<p>${renderInlineTokens(inlineTokens(token))}</p>`;
    default:
      return escapeHtml(token.raw ?? token.text ?? "");
  }
}

function renderBlockTokens(tokens) {
  return (tokens ?? []).map(renderBlockToken).join("");
}

function markdownToSafeHtml(markdown) {
  const tokens = marked.lexer(String(markdown ?? ""), { async: false, breaks: true, gfm: true });
  return renderBlockTokens(tokens);
}

function inlineText(token) {
  switch (token.type) {
    case "link": {
      const label = inlineTokens(token).map(inlineText).join("");
      const href = safeHref(token.href);
      return href ? `${label} (${href})` : label;
    }
    case "image":
      return token.text ?? "";
    case "strong":
    case "em":
    case "del":
      return inlineTokens(token).map(inlineText).join("");
    case "br":
      return "\n";
    case "codespan":
    case "escape":
    case "text":
      return String(token.text ?? token.raw ?? "");
    case "html":
      return String(token.raw ?? token.text ?? "");
    default:
      return String(token.text ?? token.raw ?? "");
  }
}

function blockText(token) {
  switch (token.type) {
    case "space":
      return "";
    case "code":
      return String(token.text ?? "");
    case "blockquote":
      return blockTokensText(token.tokens ?? []).split("\n").map((line) => line ? `> ${line}` : line).join("\n");
    case "list":
      return (token.items ?? []).map((item, index) => {
        const marker = token.ordered ? `${index + 1}.` : "-";
        const body = item.tokens?.length ? blockTokensText(item.tokens) : inlineTokens(item).map(inlineText).join("");
        return `${marker} ${body}`;
      }).join("\n");
    case "table": {
      const header = (token.header ?? []).map((cell) => inlineTokens(cell).map(inlineText).join("")).join(" | ");
      const rows = (token.rows ?? []).map((row) => row.map((cell) => inlineTokens(cell).map(inlineText).join("")).join(" | "));
      return [header, ...rows].filter(Boolean).join("\n");
    }
    case "html":
      return String(token.raw ?? token.text ?? "");
    default:
      return inlineTokens(token).map(inlineText).join("");
  }
}

function blockTokensText(tokens) {
  return (tokens ?? []).map(blockText).filter(Boolean).join("\n\n");
}

function markdownToText(markdown) {
  const tokens = marked.lexer(String(markdown ?? ""), { async: false, breaks: true, gfm: true });
  return blockTokensText(tokens);
}

module.exports = {
  escapeAttr,
  escapeHtml,
  markdownToSafeHtml,
  markdownToText,
  safeHref
};
