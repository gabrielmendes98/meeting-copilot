import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import type { Node as XmlNode } from "@xmldom/xmldom";

export const CONTEXT_EXTENSIONS = ["pdf", "docx", "txt", "md", "csv", "json"];
export const MAX_CONTEXT_CHARACTERS = 120_000;
export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;

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
