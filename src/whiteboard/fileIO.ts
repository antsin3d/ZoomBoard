import { isTauri } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { readFile, readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";

const BOARD_FILTER = {
  name: "Whiteboard document",
  extensions: ["board"],
};

export interface OpenedBoardFile {
  contents: string;
  path: string | null;
  name: string;
}

export interface PickedImage {
  dataUrl: string;
  name: string;
}

const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

function bytesToDataUrl(bytes: Uint8Array, mime: string): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return `data:${mime};base64,${btoa(binary)}`;
}

function browserOpen(): Promise<OpenedBoardFile | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".board,application/json";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) {
        resolve(null);
        return;
      }
      try {
        resolve({ contents: await file.text(), path: null, name: file.name });
      } catch (error) {
        reject(error);
      }
    };
    input.click();
  });
}

function browserSave(contents: string, suggestedName: string): string {
  const blob = new Blob([contents], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = suggestedName;
  anchor.click();
  URL.revokeObjectURL(url);
  return suggestedName;
}

export async function openBoardFile(): Promise<OpenedBoardFile | null> {
  if (!isTauri()) return browserOpen();

  const path = await open({
    multiple: false,
    directory: false,
    filters: [BOARD_FILTER],
  });
  if (!path) return null;

  const name = path.split(/[\\/]/).pop() ?? "Untitled.board";
  return { contents: await readTextFile(path), path, name };
}

export async function saveBoardFile(
  contents: string,
  currentPath: string | null,
  suggestedName = "Untitled.board",
): Promise<string | null> {
  if (!isTauri()) {
    return browserSave(contents, suggestedName);
  }

  const path = currentPath ?? await save({
    defaultPath: suggestedName,
    filters: [BOARD_FILTER],
  });
  if (!path) return currentPath;

  await writeTextFile(path, contents);
  return path;
}

export async function pickImageFile(): Promise<PickedImage | null> {
  if (!isTauri()) {
    return new Promise((resolve, reject) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "image/png,image/jpeg,image/gif,image/webp";
      input.onchange = () => {
        const file = input.files?.[0];
        if (!file) {
          resolve(null);
          return;
        }
        const reader = new FileReader();
        reader.onload = () => resolve({ dataUrl: String(reader.result), name: file.name });
        reader.onerror = () => reject(reader.error ?? new Error("The image could not be read."));
        reader.readAsDataURL(file);
      };
      input.click();
    });
  }

  const path = await open({
    multiple: false,
    directory: false,
    filters: [{ name: "Images", extensions: Object.keys(IMAGE_MIME) }],
  });
  if (!path) return null;

  const name = path.split(/[\\/]/).pop() ?? "Image";
  const extension = name.split(".").pop()?.toLowerCase() ?? "png";
  const mime = IMAGE_MIME[extension] ?? "application/octet-stream";
  return { dataUrl: bytesToDataUrl(await readFile(path), mime), name };
}
