import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import type { Node as XmlNode } from "@xmldom/xmldom";

export const CONTEXT_EXTENSIONS = [
  "pdf", "docx", "pptx", "txt", "md", "csv", "json",
  "js", "jsx", "ts", "tsx", "py", "java", "c", "cpp", "h", "hpp", "cs", "go", "rs",
  "rb", "sh", "sql", "html", "css", "yaml", "yml", "xml", "swift", "kt",
];
export const MAX_CONTEXT_CHARACTERS = 120_000;
export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;

/** Follow presentation relationships: slide filenames do not define presentation order. */
async function extractPptx(data: Buffer): Promise<string> {
  const [{ default: JSZip }, { DOMParser, onErrorStopParsing }] = await Promise.all([import("jszip"), import("@xmldom/xmldom")]);
  const zip = await JSZip.loadAsync(data);
  let expandedBytes = 0;
  async function readXml(name: string) {
    const entry = zip.file(name);
    if (!entry) throw new Error(`Invalid PPTX: missing ${name}.`);
    const stream = new Readable({ read() {} }).wrap(entry.nodeStream("nodebuffer"));
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      expandedBytes += chunk.length;
      if (expandedBytes > MAX_DOCUMENT_BYTES) throw new Error("Expanded PPTX content exceeds 20 MB.");
      chunks.push(chunk);
    }
    const xml = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
    if (/<!DOCTYPE/i.test(xml)) throw new Error("PPTX XML must not contain a document type declaration.");
    return new DOMParser({ onError: onErrorStopParsing }).parseFromString(xml, "application/xml");
  }
  const presentation = await readXml("ppt/presentation.xml");
  const relationships = await readXml("ppt/_rels/presentation.xml.rels");
  const targets = new Map<string, string>();
  for (const relation of Array.from(relationships.getElementsByTagNameNS("*", "Relationship"))) {
    if (relation.getAttribute("TargetMode") === "External" || !relation.getAttribute("Type")?.endsWith("/slide")) continue;
    const target = relation.getAttribute("Target") || "";
    const resolved = path.posix.normalize(target.startsWith("/") ? target.slice(1) : `ppt/${target}`);
    if (!/^ppt\/slides\/[^/]+\.xml$/.test(resolved)) throw new Error("Invalid PPTX slide relationship.");
    targets.set(relation.getAttribute("Id") || "", resolved);
  }
  const texts: string[] = [];
  const drawingNamespaces = new Set([
    "http://schemas.openxmlformats.org/drawingml/2006/main",
    "http://purl.oclc.org/ooxml/drawingml/main",
  ]);
  function readNode(node: XmlNode): string {
    if (drawingNamespaces.has(node.namespaceURI || "")) {
      if (node.localName === "t") return node.textContent || "";
      if (node.localName === "br") return "\n";
    }
    let text = "";
    for (let child = node.firstChild; child; child = child.nextSibling) text += readNode(child);
    return text + (drawingNamespaces.has(node.namespaceURI || "") && node.localName === "p" ? "\n" : "");
  }
  let characters = 0;
  const slides = Array.from(presentation.getElementsByTagNameNS("*", "sldId"));
  if (!slides.length) throw new Error("Invalid PPTX: no slides found.");
  for (const [index, slide] of slides.entries()) {
    const id = slide.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id")
      || slide.getAttributeNS("http://purl.oclc.org/ooxml/officeDocument/relationships", "id");
    const target = id ? targets.get(id) : undefined;
    if (!target) throw new Error("Invalid PPTX: unresolved slide relationship.");
    const text = readNode(await readXml(target)).trim();
    if (!text) continue;
    const section = `Slide ${index + 1}\n${text}`;
    characters += section.length + (texts.length ? 2 : 0);
    if (characters > MAX_CONTEXT_CHARACTERS) throw new Error("Document exceeds the 120,000-character context limit.");
    texts.push(section);
  }
  return texts.join("\n\n");
}

async function extractDocx(data: Buffer): Promise<string> {
  const [{ default: JSZip }, { DOMParser, onErrorStopParsing }] = await Promise.all([import("jszip"), import("@xmldom/xmldom")]);
  const zip = await JSZip.loadAsync(data);
  if (!zip.file("word/document.xml")) throw new Error("Invalid DOCX: no document content found.");
  const parts = Object.keys(zip.files).filter((name) => /^word\/(document|header\d+|footer\d+|footnotes|endnotes)\.xml$/.test(name)).sort();
  let expandedBytes = 0;
  function readNode(node: XmlNode): string {
    if (node.namespaceURI === "http://schemas.openxmlformats.org/wordprocessingml/2006/main") {
      if (node.localName === "del") return "";
      if (node.localName === "t") return node.textContent ?? "";
      if (node.localName === "tab") return "\t";
      if (node.localName === "br" || node.localName === "cr") return "\n";
    }
    let text = "";
    for (let child = node.firstChild; child; child = child.nextSibling) text += readNode(child);
    return text + (node.localName === "p" ? "\n" : "");
  }
  const texts: string[] = [];
  for (const name of parts) {
    const stream = new Readable({ read() {} }).wrap(zip.file(name)!.nodeStream("nodebuffer"));
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      expandedBytes += chunk.length;
      if (expandedBytes > MAX_DOCUMENT_BYTES) throw new Error("Expanded DOCX content exceeds 20 MB.");
      chunks.push(chunk);
    }
    const xml = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
    if (/<!DOCTYPE/i.test(xml)) throw new Error("DOCX XML must not contain a document type declaration.");
    const document = new DOMParser({ onError: onErrorStopParsing }).parseFromString(xml, "application/xml");
    texts.push(readNode(document));
  }
  return texts.join("\n");
}

export async function extractContextDocument(filePath: string): Promise<string> {
  const extension = path.extname(filePath).slice(1).toLowerCase();
  if (!CONTEXT_EXTENSIONS.includes(extension)) throw new Error("Unsupported document format.");
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) throw new Error("Choose a document file.");
  if (stat.size > MAX_DOCUMENT_BYTES) throw new Error("Documents must be 20 MB or smaller.");
  const data = await fs.readFile(filePath);
  let text: string;
  if (extension === "pdf") {
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data: new Uint8Array(data), isEvalSupported: false });
    try { text = (await parser.getText({ pageJoiner: "" })).text; }
    finally { await parser.destroy(); }
  } else if (extension === "docx") {
    text = await extractDocx(data);
  } else if (extension === "pptx") {
    text = await extractPptx(data);
  } else {
    // Reject binary files masquerading as text instead of passing garbage to the agent.
    text = new TextDecoder("utf-8", { fatal: true }).decode(data);
    if (text.includes("\0")) throw new Error("Use a UTF-8 text document.");
  }
  text = text.trim();
  if (!text) throw new Error("No readable text found. Scanned PDFs need OCR before importing.");
  if (text.length > MAX_CONTEXT_CHARACTERS) throw new Error("Document exceeds the 120,000-character context limit.");
  return text;
}
