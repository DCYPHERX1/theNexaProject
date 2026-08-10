const { spawn } = require("child_process");
const fs = require("fs");
const net = require("net");
const path = require("path");

const root = path.join(__dirname, "..");
const backendRoot = path.join(root, "backend");
const backendEntry = path.join(backendRoot, "src", "server.js");
const backendModules = path.join(backendRoot, "node_modules");

const processes = [];

function isPortOpen(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
    socket.setTimeout(1000, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

function run(label, command, args, cwd) {
  const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
  processes.push(child);
  child.stdout.on("data", (chunk) => process.stdout.write(`[${label}] ${chunk}`));
  child.stderr.on("data", (chunk) => process.stderr.write(`[${label}] ${chunk}`));
  child.on("exit", (code) => {
    if (code) process.stderr.write(`[${label}] exited with code ${code}\n`);
  });
}

async function main() {
  const apiPort = Number(process.env.API_PORT || process.env.PORT_API || 4000);
  const webPort = Number(process.env.PORT || 5177);

  if (fs.existsSync(backendEntry) && fs.existsSync(backendModules)) {
    if (await isPortOpen(apiPort)) {
      console.log(`[api] using existing backend at http://127.0.0.1:${apiPort}`);
    } else {
      run("api", "node", ["src/server.js"], backendRoot);
    }
  } else {
    console.warn("[api] backend dependencies missing. Run: cd backend && npm install");
  }

  if (await isPortOpen(webPort)) {
    console.log(`[web] using existing frontend at http://localhost:${webPort}/`);
  } else {
    run("web", "node", ["scripts/dev-server.js"], root);
  }
}

main().catch((error) => {
  console.error(error);
  shutdown(1);
});

function shutdown(code = 0) {
  for (const child of processes) child.kill();
  process.exit(code);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
