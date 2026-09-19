function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderInline(value) {
  let html = escapeHtml(value);

  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");

  return html;
}

function stripFrontmatter(source) {
  const normalized = source.replaceAll("\r\n", "\n");

  if (!normalized.startsWith("---\n")) {
    return normalized;
  }

  const end = normalized.indexOf("\n---\n", 4);

  if (end === -1) {
    throw new Error("Malformed legal document frontmatter");
  }

  return normalized.slice(end + 5);
}

export function renderLegalMarkdown(source) {
  if (typeof source !== "string" || source.length === 0) {
    throw new Error("Invalid legal document source");
  }

  const body = stripFrontmatter(source);
  const lines = body.split("\n");
  const output = [];
  let listOpen = false;

  const closeList = () => {
    if (listOpen) {
      output.push("</ul>");
      listOpen = false;
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();

    if (!line.trim()) {
      closeList();
      continue;
    }

    if (line.startsWith("### ")) {
      closeList();
      output.push(`<h3>${renderInline(line.slice(4))}</h3>`);
      continue;
    }

    if (line.startsWith("## ")) {
      closeList();
      output.push(`<h2>${renderInline(line.slice(3))}</h2>`);
      continue;
    }

    if (line.startsWith("# ")) {
      closeList();
      output.push(`<h1>${renderInline(line.slice(2))}</h1>`);
      continue;
    }

    if (line.startsWith("- ")) {
      if (!listOpen) {
        output.push("<ul>");
        listOpen = true;
      }

      output.push(`<li>${renderInline(line.slice(2))}</li>`);
      continue;
    }

    if (line.startsWith("> ")) {
      closeList();
      output.push(`<blockquote>${renderInline(line.slice(2))}</blockquote>`);
      continue;
    }

    closeList();
    output.push(`<p>${renderInline(line)}</p>`);
  }

  closeList();

  return output.join("\n");
}
