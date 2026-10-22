(function (root, factory) {
  const renderMarkdown = factory();
  if (typeof module === "object" && module.exports) module.exports = renderMarkdown;
  else root.renderMarkdown = renderMarkdown;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  function escapeHtml(value) {
    return value.replace(/[&<>"']/g, (char) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[char]));
  }

  function renderInline(raw) {
    const text = String(raw);
    let html = "";
    let index = 0;
    while (index < text.length) {
      if (text.startsWith("***", index)) {
        const end = text.indexOf("***", index + 3);
        if (end !== -1) {
          html += `<strong><em>${renderInline(text.slice(index + 3, end))}</em></strong>`;
          index = end + 3;
          continue;
        }
      }
      const marker = text.startsWith("**", index) ? "**" : text.startsWith("__", index) ? "__" : "";
      if (marker) {
        const end = text.indexOf(marker, index + 2);
        if (end !== -1) {
          html += `<strong>${renderInline(text.slice(index + 2, end))}</strong>`;
          index = end + 2;
          continue;
        }
      }
      if (text[index] === "`") {
        const end = text.indexOf("`", index + 1);
        if (end !== -1) {
          html += `<code>${escapeHtml(text.slice(index + 1, end))}</code>`;
          index = end + 1;
          continue;
        }
      }
      if (text[index] === "*") {
        const end = text.indexOf("*", index + 1);
        const inner = end === -1 ? "" : text.slice(index + 1, end);
        if (inner && !inner.includes("\n") && text[index + 1] !== " " && text[index + 1] !== "*") {
          html += `<em>${renderInline(inner)}</em>`;
          index = end + 1;
          continue;
        }
      }
      const image = /^!\[([^\]]*)\]\([^)]+\)/.exec(text.slice(index));
      if (image) {
        html += escapeHtml(image[1]);
        index += image[0].length;
        continue;
      }
      const link = /^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/.exec(text.slice(index));
      if (link) {
        html += `<span class="md-link">${renderInline(link[1])}</span>`;
        index += link[0].length;
        continue;
      }
      html += escapeHtml(text[index]);
      index += 1;
    }
    return html;
  }

  function isFence(line) { return /^\s*```/.test(line); }
  function isHeading(line) { return /^#{1,6}\s+\S/.test(line); }
  function isQuote(line) { return /^\s*>/.test(line); }
  function isBullet(line) { return /^\s*[-*+]\s+\S/.test(line); }
  function isOrdered(line) { return /^\s*\d+[.)]\s+\S/.test(line); }
  function isRule(line) { return /^(-{3,}|\*{3,}|_{3,})$/.test(line.trim()); }
  function isTableRow(line) { return /^\s*\|.+\|\s*$/.test(line); }
  function isTableSeparator(line) { return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line); }
  function isBlockStart(line) {
    return isFence(line) || isHeading(line) || isQuote(line) || isBullet(line) || isOrdered(line) || isRule(line);
  }
  function splitCells(line) {
    return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
  }

  function renderList(items, ordered) {
    const tag = ordered ? "ol" : "ul";
    const body = items.map((item) => {
      const task = /^\[([ xX])\]\s+([\s\S]+)$/.exec(item);
      if (!ordered && task) {
        const done = task[1].toLowerCase() === "x" ? " done" : "";
        return `<li class="task${done}">${renderInline(task[2])}</li>`;
      }
      return `<li>${renderInline(item)}</li>`;
    }).join("");
    return `<${tag}>${body}</${tag}>`;
  }

  function collect(lines, index, takeItem, skipGap) {
    const items = [];
    while (index < lines.length) {
      if (takeItem(lines[index])) {
        items.push(lines[index]);
        index += 1;
        continue;
      }
      if (!lines[index].trim() && lines[index + 1] && skipGap(lines[index + 1])) {
        index += 1;
        continue;
      }
      break;
    }
    return { items, index };
  }

  function renderMarkdown(source) {
    const lines = String(source || "").replace(/\r\n/g, "\n").split("\n");
    const blocks = [];
    let index = 0;
    while (index < lines.length) {
      const line = lines[index];
      if (!line.trim()) { index += 1; continue; }
      if (isFence(line)) {
        const lang = (line.trim().slice(3).trim().split(/\s+/)[0] || "").replace(/[^a-zA-Z0-9_+-]/g, "").slice(0, 24);
        const code = [];
        index += 1;
        while (index < lines.length && !isFence(lines[index])) { code.push(lines[index]); index += 1; }
        if (index < lines.length) index += 1;
        blocks.push(`<pre${lang ? ` data-lang="${lang}"` : ""}><code>${escapeHtml(code.join("\n"))}</code></pre>`);
        continue;
      }
      if (isRule(line)) { blocks.push("<hr>"); index += 1; continue; }
      const heading = /^(#{1,6})\s+(.+)$/.exec(line);
      if (heading) {
        blocks.push(`<h${heading[1].length}>${renderInline(heading[2].trim())}</h${heading[1].length}>`);
        index += 1;
        continue;
      }
      if (isQuote(line)) {
        const collected = collect(lines, index, isQuote, isQuote);
        const parts = collected.items.filter((item) => item.trim()).map((item) => `<p>${renderInline(item.replace(/^\s*>\s?/, ""))}</p>`);
        blocks.push(`<blockquote>${parts.join("")}</blockquote>`);
        index = collected.index;
        continue;
      }
      if (isBullet(line) || isOrdered(line)) {
        const ordered = isOrdered(line);
        const pattern = ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*+]\s+/;
        const matches = (item) => pattern.test(item);
        const collected = collect(lines, index, matches, matches);
        blocks.push(renderList(collected.items.map((item) => item.replace(pattern, "")), ordered));
        index = collected.index;
        continue;
      }
      if (isTableRow(line) && isTableSeparator(lines[index + 1] || "")) {
        const rows = [splitCells(line)];
        index += 2;
        while (index < lines.length && isTableRow(lines[index])) { rows.push(splitCells(lines[index])); index += 1; }
        const [header, ...body] = rows;
        const head = header.map((cell) => `<th>${renderInline(cell)}</th>`).join("");
        const rest = body.map((row) => `<tr>${row.map((cell) => `<td>${renderInline(cell)}</td>`).join("")}</tr>`).join("");
        blocks.push(`<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${rest}</tbody></table></div>`);
        continue;
      }
      const paragraph = [];
      while (index < lines.length && lines[index].trim() && !isBlockStart(lines[index])) {
        paragraph.push(lines[index]);
        index += 1;
      }
      if (paragraph.length) blocks.push(`<p>${paragraph.map((part) => renderInline(part)).join("<br>")}</p>`);
      else index += 1;
    }
    return blocks.join("");
  }

  return renderMarkdown;
});
