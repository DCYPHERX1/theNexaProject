const http = require("http");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const port = Number(process.env.PORT || 5177);
const apiTarget = process.env.NEXA_API_TARGET || "http://127.0.0.1:4000";
const backendEnvPath = path.join(root, "backend", ".env");

const types = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".jpg": "image/jpeg",
  ".png": "image/png",
};

const server = http.createServer((request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);

  if (url.pathname === "/favicon.ico") {
    fs.readFile(path.join(root, "images", "nexa-logo.png"), (error, data) => {
      if (error) {
        response.writeHead(204);
        response.end();
        return;
      }
      response.writeHead(200, {
        "Cache-Control": "public, max-age=86400",
        "Content-Type": "image/png",
      });
      response.end(data);
    });
    return;
  }

  // Expose only browser-safe Supabase config from backend/.env. Never expose service keys.
  if (url.pathname === "/js/runtime-config.js") {
    const env = readBackendEnv();
    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Type": "text/javascript; charset=utf-8",
    });
    response.end(`window.NEXA_SUPABASE_URL=${JSON.stringify(env.SUPABASE_URL || "")};\nwindow.NEXA_SUPABASE_PUBLISHABLE_KEY=${JSON.stringify(env.SUPABASE_PUBLISHABLE_KEY || "")};\nwindow.NEXA_RECAPTCHA_SITE_KEY=${JSON.stringify(env.RECAPTCHA_SITE_KEY || "")};\nwindow.NEXA_API_BASE_URL="";\nwindow.NEXA_API_TARGET=${JSON.stringify(apiTarget)};\n`);
    return;
  }

  // Keep the frontend on one localhost while proxying API calls to the backend server.
  if (url.pathname.startsWith("/api/")) {
    const target = new URL(url.pathname + url.search, apiTarget);
    const proxyRequest = http.request(target, {
      method: request.method,
      headers: {
        ...request.headers,
        host: target.host,
        origin: `http://${request.headers.host}`,
      },
    }, (proxyResponse) => {
      response.writeHead(proxyResponse.statusCode || 502, proxyResponse.headers);
      proxyResponse.pipe(response);
    });

    proxyRequest.on("error", () => {
      response.writeHead(502, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: "Nexaa backend is not running" }));
    });

    request.pipe(proxyRequest);
    return;
  }

  // Static file serving for the no-build frontend.
  const appRoutes = new Set(["/root"]);
  const pathname = url.pathname === "/" || appRoutes.has(url.pathname) ? "/index.html" : url.pathname;
  const filePath = path.join(root, path.normalize(pathname));

  if (!filePath.startsWith(root)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }

    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Type": types[path.extname(filePath)] || "application/octet-stream",
    });
    response.end(data);
  });
});

function readBackendEnv() {
  // Small .env parser for the two public values needed by the browser.
  if (!fs.existsSync(backendEnvPath)) return {};
  return fs.readFileSync(backendEnvPath, "utf8")
    .split(/\r?\n/)
    .reduce((env, line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return env;
      const index = trimmed.indexOf("=");
      if (index < 1) return env;
      const key = trimmed.slice(0, index).trim();
      const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, "");
      if (key === "SUPABASE_URL" || key === "SUPABASE_PUBLISHABLE_KEY" || key === "RECAPTCHA_SITE_KEY") env[key] = value;
      return env;
    }, {});
}

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`Nexaa dev server is already running at http://localhost:${port}/`);
    console.error("Close the existing server window, or keep using the current one.");
    process.exit(0);
  }

  throw error;
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Nexaa dev server running at http://localhost:${port}/`);
});
