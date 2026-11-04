// Icons from Material Icon Theme (MIT) — see THIRD_PARTY_NOTICES.md.
const urls = import.meta.glob("../assets/file-icons/*.svg", {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;

const defaultUrl = urls["../assets/file-icons/file.svg"];

const BY_NAME: Record<string, string> = {
  ".editorconfig": "editorconfig",
  ".eslintrc.json": "eslint",
  ".gitattributes": "git",
  ".gitignore": "git",
  ".npmrc": "npm",
  ".nvmrc": "nodejs",
  ".prettierrc": "prettier",
  "cargo.lock": "lock",
  "cargo.toml": "toml",
  "cmakelists.txt": "cmake",
  "docker-compose.yml": "docker",
  dockerfile: "docker",
  "eslint.config.js": "eslint",
  license: "license",
  "license.md": "license",
  "license.txt": "license",
  makefile: "makefile",
  "package-lock.json": "nodejs",
  "package.json": "nodejs",
  "pnpm-lock.yaml": "pnpm",
  readme: "readme",
  "readme.md": "readme",
  "tauri.conf.json": "tauri",
  "tsconfig.json": "tsconfig",
  "vite.config.ts": "vite",
  "yarn.lock": "yarn",
};

const BY_EXTENSION: Record<string, string> = {
  "7z": "zip",
  asm: "assembly",
  astro: "astro",
  avif: "image",
  bash: "console",
  bmp: "image",
  bz2: "zip",
  c: "c",
  cc: "cpp",
  cfg: "settings",
  cjs: "javascript",
  clj: "clojure",
  cljs: "clojure",
  conf: "settings",
  cpp: "cpp",
  cs: "csharp",
  css: "css",
  csv: "table",
  cxx: "cpp",
  dart: "dart",
  db: "database",
  diff: "diff",
  docx: "word",
  env: "tune",
  eot: "font",
  erl: "erlang",
  ex: "elixir",
  exs: "elixir",
  fish: "console",
  flac: "audio",
  gif: "image",
  go: "go",
  gql: "graphql",
  graphql: "graphql",
  gz: "zip",
  h: "h",
  hpp: "hpp",
  hs: "haskell",
  htm: "html",
  html: "html",
  ico: "image",
  ini: "settings",
  ipynb: "jupyter",
  java: "java",
  jpeg: "image",
  jpg: "image",
  js: "javascript",
  json: "json",
  json5: "json",
  jsonc: "json",
  jsx: "react",
  kt: "kotlin",
  kts: "kotlin",
  less: "less",
  lock: "lock",
  log: "log",
  lua: "lua",
  md: "markdown",
  mdx: "mdx",
  mjs: "javascript",
  mkv: "video",
  mov: "video",
  mp3: "audio",
  mp4: "video",
  ogg: "video",
  otf: "font",
  patch: "git",
  pdf: "pdf",
  php: "php",
  png: "image",
  pptx: "powerpoint",
  proto: "proto",
  ps1: "powershell",
  py: "python",
  r: "r",
  rar: "zip",
  rb: "ruby",
  rs: "rust",
  rtf: "word",
  sass: "sass",
  scala: "scala",
  scss: "sass",
  sh: "console",
  sol: "solidity",
  sql: "database",
  sqlite: "database",
  sqlite3: "database",
  styl: "stylus",
  svelte: "svelte",
  svg: "svg",
  swift: "swift",
  tar: "zip",
  tgz: "zip",
  toml: "toml",
  ts: "typescript",
  tsv: "table",
  tsx: "react_ts",
  ttf: "font",
  txt: "document",
  vue: "vue",
  wasm: "webassembly",
  wav: "audio",
  webm: "video",
  webp: "image",
  woff: "font",
  woff2: "font",
  xlsx: "table",
  xml: "xml",
  xz: "zip",
  yaml: "yaml",
  yml: "yaml",
  zig: "zig",
  zip: "zip",
  zsh: "console",
};

function iconUrl(name: string) {
  const id = fileIconId(name);
  return urls[`../assets/file-icons/${id}.svg`] ?? defaultUrl;
}

export function fileIconId(name: string) {
  const lower = name.toLowerCase();
  return BY_NAME[lower] ?? BY_EXTENSION[lower.slice(lower.lastIndexOf(".") + 1)] ?? "file";
}

export function FileIcon({ name, size = 16 }: { name: string; size?: number }) {
  return (
    <img
      className="file-icon"
      src={iconUrl(name)}
      width={size}
      height={size}
      alt=""
      aria-hidden
      draggable={false}
    />
  );
}
