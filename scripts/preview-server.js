const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const root = path.resolve(__dirname, "..", "dist");
const port = Number(process.env.PORT || 4174);
const basePath = "/Daily_CS/";

const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml"
};

function classifyRequestPath(distRoot, urlPath, siteBasePath = basePath) {
  let decoded;
  try {
    decoded = decodeURIComponent(String(urlPath || "/").split("?")[0]);
  } catch {
    return { status: 400, filePath: null };
  }
  if (decoded === "/") decoded = siteBasePath;
  if (!decoded.startsWith(siteBasePath)) return { status: 403, filePath: null };
  const relative = decoded.slice(siteBasePath.length) || "index.html";
  const fullPath = path.resolve(distRoot, relative.endsWith("/") ? path.join(relative, "index.html") : relative);
  const rel = path.relative(path.resolve(distRoot), fullPath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return { status: 403, filePath: null };
  return { status: 200, filePath: fullPath };
}

function createPreviewServer(options = {}) {
  const distRoot = options.root ?? root;
  const siteBasePath = options.basePath ?? basePath;
  return http.createServer((req, res) => {
    const result = classifyRequestPath(distRoot, req.url ?? "/", siteBasePath);
    if (result.status !== 200) {
      res.writeHead(result.status);
      res.end(result.status === 400 ? "Bad request" : "Forbidden");
      return;
    }
    fs.readFile(result.filePath, (error, data) => {
      if (error) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      res.writeHead(200, { "Content-Type": types[path.extname(result.filePath)] ?? "application/octet-stream" });
      res.end(data);
    });
  });
}

if (require.main === module) {
  createPreviewServer().listen(port, "127.0.0.1", () => {
    console.log(`Preview server: http://127.0.0.1:${port}${basePath}`);
  });
}

module.exports = { classifyRequestPath, createPreviewServer };
