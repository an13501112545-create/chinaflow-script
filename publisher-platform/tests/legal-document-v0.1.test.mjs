import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { renderLegalMarkdown } from "../legal-document-v0.1.mjs";

const sourceUrl = new URL("../legal/chinaflow-publisher-terms-v1.md", import.meta.url);
const source = readFileSync(sourceUrl, "utf8");

test("authoritative v1 legal source has frozen expected bytes", () => {
  assert.equal(
    createHash("sha256").update(source).digest("hex"),
    "10f076db643d30c22689b9d4f87c1107a5944612f2f40438004b58d4c7b66f14"
  );
});

test("renderer strips YAML frontmatter and renders exact supported legal structure", () => {
  const html = renderLegalMarkdown(source);

  assert.match(html, /<h1>ChinaFlow Publisher Program Terms<\/h1>/);
  assert.match(html, /<h2>English Terms<\/h2>/);
  assert.match(html, /<h2>中文条款<\/h2>/);
  assert.match(html, /<h3>1\. Definitions<\/h3>/);
  assert.match(html, /<h3>21\. 语言<\/h3>/);

  assert.equal((html.match(/<h1>/g) ?? []).length, 1);
  assert.equal((html.match(/<h2>/g) ?? []).length, 2);
  assert.equal((html.match(/<h3>/g) ?? []).length, 42);

  assert.match(html, /<ul>[\s\S]*<strong>Publisher: 70%<\/strong>[\s\S]*<\/ul>/);
  assert.match(html, /<ul>[\s\S]*<strong>发布商：70%<\/strong>[\s\S]*<\/ul>/);
  assert.match(html, /<blockquote>以下中文条款依据上述英文条款逐条对应翻译，用于提高阅读便利性。<\/blockquote>/);

  assert.ok(!html.includes("document_id:"));
  assert.ok(!html.includes("source_note:"));
  assert.ok(!html.includes("Reconstructed authoritative source candidate"));
});

test("renderer supports inline bold and code while escaping HTML", () => {
  const html = renderLegalMarkdown(`# <script>alert("x")</script>

**Safe & sound** and \`code<value>\`

- **Item <one>**

> quoted <tag>
`);

  assert.match(html, /<h1>&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;<\/h1>/);
  assert.match(html, /<strong>Safe &amp; sound<\/strong>/);
  assert.match(html, /<code>code&lt;value&gt;<\/code>/);
  assert.match(html, /<li><strong>Item &lt;one&gt;<\/strong><\/li>/);
  assert.match(html, /<blockquote>quoted &lt;tag&gt;<\/blockquote>/);
  assert.ok(!html.includes("<script>"));
  assert.ok(!html.includes("<tag>"));
});
