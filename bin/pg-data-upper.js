#!/usr/bin/env node

const crypto = require("crypto");
const fs = require("fs");
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
  fs.appendFileSync(destination, fs.readFileSync(source));
}

function rmrf(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

function findExtractedPart(root, partFileName) {
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.name === partFileName) {
        return fullPath;
      }
    }
  }
  throw new Error(`Could not find ${partFileName} after package extraction`);
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
    console.log(`Downloading ${manifest.parts.length} npm package parts...`);

    manifest.parts.forEach((part, index) => {
      const packageSpec = `${part.package}@${manifest.partVersion}`;
      const partWorkDir = path.join(tempDir, `part-${String(index + 1).padStart(3, "0")}`);
      fs.mkdirSync(partWorkDir, { recursive: true });

      process.stdout.write(`[${index + 1}/${manifest.parts.length}] ${packageSpec}\n`);
      const packOutput = run("npm", ["pack", packageSpec, "--pack-destination", partWorkDir], { capture: true });
      const tarballName = packOutput.trim().split(/\r?\n/).filter(Boolean).pop();
      if (!tarballName) {
        throw new Error(`npm pack did not return a tarball name for ${packageSpec}`);
      }

      const tarballPath = path.join(partWorkDir, tarballName);
      run("tar", ["-xzf", tarballPath, "-C", partWorkDir]);
      const extractedPart = findExtractedPart(partWorkDir, part.file);
      appendFile(extractedPart, archivePath);
    });

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
