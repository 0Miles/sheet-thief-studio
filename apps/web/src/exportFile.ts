// A score exported to a file (docs/spec/import-export.md, section 3): Guitar Pro 7 or MIDI, written
// by score-render from the score's projection, named after the score's title, and handed to the
// browser to save. The mixer is the member's, not the score's: it is not applied.
import type { ScoreJSON } from "@studio/score-model";
import { exportGp7, exportMidi } from "@studio/score-render";

import { strings } from "./strings";

export type ExportFormat = "gp7" | "midi";

export const EXPORT_FORMATS: readonly ExportFormat[] = ["gp7", "midi"];

const FORMATS: Record<ExportFormat, { extension: string; type: string; write: (json: ScoreJSON) => Uint8Array }> = {
  // A Guitar Pro 7 file is a zip; no media type is registered for it.
  gp7: { extension: ".gp", type: "application/octet-stream", write: exportGp7 },
  midi: { extension: ".mid", type: "audio/midi", write: exportMidi },
};

/** The characters Windows keeps out of file names. */
const RESERVED = new Set('<>:"/\\|?*');

/** Whether a file name may hold the character on any system the browser saves to: none holds a reserved or a control character. */
function fitsFileName(character: string): boolean {
  const code = character.codePointAt(0)!;
  return !RESERVED.has(character) && code >= 0x20 && code !== 0x7f;
}

/** The name of the file a score is exported to: its title, 「未命名」 when it has none, with what no file name may hold made `_`. */
export function exportName(title: string, format: ExportFormat): string {
  const name = title === "" ? strings.score.untitled : title;
  const fitting = [...name].map((character) => (fitsFileName(character) ? character : "_")).join("");
  return `${fitting}${FORMATS[format].extension}`;
}

export interface ExportedFile {
  name: string;
  type: string;
  bytes: Uint8Array;
}

/** A score written as a file of the format, and its name. */
export function exportedFile(json: ScoreJSON, format: ExportFormat): ExportedFile {
  const { type, write } = FORMATS[format];
  return { name: exportName(json.title, format), type, bytes: write(json) };
}

/** The browser saves the file, as a download of its own: nothing is sent anywhere. */
export function saveFile(file: ExportedFile): void {
  const url = URL.createObjectURL(new Blob([file.bytes as Uint8Array<ArrayBuffer>], { type: file.type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = file.name;
  // In the document while clicked, as older Firefox needs it to be.
  document.body.append(link);
  link.click();
  link.remove();
  // Once the browser has started the download, which reads the URL first.
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
