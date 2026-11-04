export function errorCode(error: unknown): string | null {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return null;
}

export function errorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    if ("message" in error && typeof error.message === "string") return error.message;
    if ("error" in error && typeof error.error === "string") return error.error;
  }
  if (error instanceof Error) return error.message;
  return "发生了未知错误。";
}

export function basename(path: string): string {
  const segments = path.split("/");
  return segments[segments.length - 1] || path;
}

export function parentPath(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? "" : path.slice(0, index);
}

export function tabKey(projectId: string, path: string): string {
  return `${projectId}\u0000${path}`;
}
