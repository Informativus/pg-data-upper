#!/usr/bin/env node

const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const https = require("https");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const manifest = require("../package-parts.json");

function usage() {
  console.log(`Usage:
  npx pg-data-upper install [--dir <path>] [--force] [--keep-archive]

Options:
  --dir <path>      Install directory. Defaults to ./pg-data-upper-kit
  --force           Remove an existing install directory before extraction
  --keep-archive    Keep the reconstructed archive after install
`);
}

function parseArgs(argv) {
  const args = { command: argv[2], dir: null, force: false, keepArchive: false };
  if (args.command === "--help" || args.command === "-h") {
    args.command = "help";
  }
  for (let index = 3; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dir") {
      args.dir = argv[index + 1];
      index += 1;
    } else if (arg === "--force") {
      args.force = true;
    } else if (arg === "--keep-archive") {
      args.keepArchive = true;
    } else if (arg === "--help" || arg === "-h") {
      args.command = "help";
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    encoding: "utf8",
    ...options
  });

  if (result.status !== 0) {
    const stderr = result.stderr ? `\n${result.stderr}` : "";
    throw new Error(`${command} ${args.join(" ")} failed${stderr}`);
  }

  return result.stdout || "";
}

function sha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", chunk => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function appendFile(source, destination) {
  return new Promise((resolve, reject) => {
    const input = fs.createReadStream(source);
    const output = fs.createWriteStream(destination, { flags: "a" });
    input.on("error", reject);
    output.on("error", reject);
    output.on("finish", resolve);
    input.pipe(output);
  });
}

function rmrf(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

function downloadFile(url, destination, redirects = 0) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https:") ? https : http;
    const request = client.get(url, response => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        response.resume();
        if (!response.headers.location || redirects >= 5) {
          reject(new Error(`Too many redirects while downloading ${url}`));
          return;
        }
        const nextUrl = new URL(response.headers.location, url).toString();
        downloadFile(nextUrl, destination, redirects + 1).then(resolve, reject);
        return;
      }

      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Download failed ${response.statusCode} for ${url}`));
        return;
      }

      const output = fs.createWriteStream(destination);
      output.on("finish", resolve);
      output.on("error", reject);
      response.on("error", reject);
      response.pipe(output);
    });
    request.on("error", reject);
  });
}

function fetchJson(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https:") ? https : http;
    const request = client.get(url, response => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        response.resume();
        if (!response.headers.location || redirects >= 5) {
          reject(new Error(`Too many redirects while fetching ${url}`));
          return;
        }
        const nextUrl = new URL(response.headers.location, url).toString();
        fetchJson(nextUrl, redirects + 1).then(resolve, reject);
        return;
      }

      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Request failed ${response.statusCode} for ${url}`));
        return;
      }

      let body = "";
      response.setEncoding("utf8");
      response.on("data", chunk => {
        body += chunk;
      });
      response.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(new Error(`Invalid JSON from ${url}: ${error.message}`));
        }
      });
      response.on("error", reject);
    });
    request.on("error", reject);
  });
}

async function appendGithubRawPart(part, archivePath, tempDir) {
  const partPath = path.join(tempDir, part.file);
  const partUrl = `${manifest.source.baseUrl}/${encodeURIComponent(part.file)}`;

  await downloadFile(partUrl, partPath);
  await appendFile(partPath, archivePath);
  fs.rmSync(partPath, { force: true });
}

async function appendNpmRegistryPart(part, archivePath, tempDir) {
  if (!part.package || !part.file) {
    throw new Error("npm-registry manifest part is missing package or file.");
  }

  const registry = (manifest.source.registry || "https://registry.npmjs.org").replace(/\/$/, "");
  const partVersion = manifest.partVersion || manifest.version;
  const metadataUrl = `${registry}/${encodeURIComponent(part.package)}`;
  const metadata = await fetchJson(metadataUrl);
  const versionMetadata = metadata.versions && metadata.versions[partVersion];
  const tarballUrl = versionMetadata && versionMetadata.dist && versionMetadata.dist.tarball;

  if (!tarballUrl) {
    throw new Error(`Package ${part.package}@${partVersion} does not expose a tarball URL.`);
  }

  const packageTarPath = path.join(tempDir, `${part.file}.tgz`);
  const extractDir = path.join(tempDir, `${part.file}-package`);
  await downloadFile(tarballUrl, packageTarPath);
  fs.mkdirSync(extractDir, { recursive: true });
  run("tar", ["-xzf", packageTarPath, "-C", extractDir]);

  const extractedPartPath = path.join(extractDir, "package", "data", part.file);
  if (!fs.existsSync(extractedPartPath)) {
    throw new Error(`Part file not found in ${part.package}@${partVersion}: data/${part.file}`);
  }

  await appendFile(extractedPartPath, archivePath);
}

async function install(args) {
  if (!manifest.archiveSha256 || manifest.parts.length === 0) {
    throw new Error("Installer manifest is incomplete. Re-publish the package with package-parts.json populated.");
  }

  const installDir = path.resolve(args.dir || path.join(process.cwd(), manifest.defaultInstallDir));
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pg-data-upper-"));
  const archivePath = path.join(tempDir, manifest.archiveName);

  try {
    if (fs.existsSync(installDir)) {
      if (!args.force) {
        throw new Error(`Install directory already exists: ${installDir}. Use --force to replace it.`);
      }
      rmrf(installDir);
    }

    fs.mkdirSync(tempDir, { recursive: true });
    fs.writeFileSync(archivePath, "");

    console.log(`Installing pg-data-upper offline kit into: ${installDir}`);
    if (!manifest.source || !manifest.source.type) {
      throw new Error("Installer manifest source is invalid.");
    }

    if (manifest.source.type === "github-raw" && !manifest.source.baseUrl) {
      throw new Error("Installer manifest GitHub source is invalid.");
    }

    if (manifest.source.type === "npm-registry" && !manifest.partVersion) {
      throw new Error("Installer manifest npm source is missing partVersion.");
    }

    if (!["github-raw", "npm-registry"].includes(manifest.source.type)) {
      throw new Error(`Unsupported installer source: ${manifest.source.type}`);
    }

    console.log(`Downloading ${manifest.parts.length} ${manifest.source.type} parts...`);

    for (let index = 0; index < manifest.parts.length; index += 1) {
      const part = manifest.parts[index];
      process.stdout.write(`[${index + 1}/${manifest.parts.length}] ${part.file}\n`);
      if (manifest.source.type === "github-raw") {
        await appendGithubRawPart(part, archivePath, tempDir);
      } else {
        await appendNpmRegistryPart(part, archivePath, tempDir);
      }
    }

    const actualSha = await sha256(archivePath);
    if (actualSha !== manifest.archiveSha256) {
      throw new Error(`Archive checksum mismatch. Expected ${manifest.archiveSha256}, got ${actualSha}`);
    }

    fs.mkdirSync(installDir, { recursive: true });
    run("tar", ["-xzf", archivePath, "-C", installDir]);

    if (args.keepArchive) {
      const keptArchive = path.join(installDir, manifest.archiveName);
      fs.copyFileSync(archivePath, keptArchive);
      console.log(`Archive kept at: ${keptArchive}`);
    }

    console.log("Install complete.");
    console.log(`Next: cd "${installDir}"`);
  } finally {
    if (!args.keepArchive) {
      rmrf(tempDir);
    }
  }
}

try {
  const args = parseArgs(process.argv);
  if (!args.command || args.command === "help") {
    usage();
  } else if (args.command === "install") {
    install(args).catch(error => {
      console.error(`pg-data-upper: ${error.message}`);
      process.exit(1);
    });
  } else {
    throw new Error(`Unknown command: ${args.command}`);
  }
} catch (error) {
  console.error(`pg-data-upper: ${error.message}`);
  process.exit(1);
}
