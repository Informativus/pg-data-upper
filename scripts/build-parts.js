const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const rootDir = path.resolve(__dirname, "..");
const archiveName = "pg-data-upper-kit-1.0.2.tar.gz";
const archivePath = path.join(rootDir, ".dist", archiveName);
const partsRoot = path.join(rootDir, ".npm-parts");
const manifestPath = path.join(rootDir, "package-parts.json");

const version = "1.0.2";
const partScope = "@greenbabuino";
const partNamePrefix = "pg-data-upper-part-";
const chunkSize = 90 * 1024 * 1024;

function sha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", chunk => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function splitArchive() {
  fs.mkdirSync(partsRoot, { recursive: true });
  for (const entry of fs.readdirSync(partsRoot)) {
    if (entry.startsWith(partNamePrefix)) {
      fs.rmSync(path.join(partsRoot, entry), { recursive: true, force: true });
    }
  }

  const parts = [];
  const input = fs.openSync(archivePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let partIndex = 1;
  let currentBytes = 0;
  let currentFd = null;
  let currentFileName = "";
  let currentPackageDir = "";

  function openPart() {
    const suffix = String(partIndex).padStart(3, "0");
    const packageName = `${partScope}/${partNamePrefix}${suffix}`;
    currentFileName = `part-${suffix}.bin`;
    currentPackageDir = path.join(partsRoot, `${partNamePrefix}${suffix}`);
    fs.mkdirSync(path.join(currentPackageDir, "data"), { recursive: true });
    currentFd = fs.openSync(path.join(currentPackageDir, "data", currentFileName), "w");
    currentBytes = 0;

    writeJson(path.join(currentPackageDir, "package.json"), {
      name: packageName,
      version,
      description: `Part ${suffix} of the pg-data-upper offline kit.`,
      files: ["data/"],
      license: "UNLICENSED"
    });

    parts.push({
      package: packageName,
      file: currentFileName
    });
  }

  function closePart() {
    if (currentFd !== null) {
      fs.closeSync(currentFd);
      currentFd = null;
      partIndex += 1;
    }
  }

  openPart();
  try {
    while (true) {
      const bytesRead = fs.readSync(input, buffer, 0, buffer.length, null);
      if (bytesRead === 0) {
        break;
      }

      let offset = 0;
      while (offset < bytesRead) {
        const available = chunkSize - currentBytes;
        const toWrite = Math.min(available, bytesRead - offset);
        fs.writeSync(currentFd, buffer, offset, toWrite);
        currentBytes += toWrite;
        offset += toWrite;

        if (currentBytes === chunkSize && offset < bytesRead) {
          closePart();
          openPart();
        }
      }
    }
  } finally {
    closePart();
    fs.closeSync(input);
  }

  return parts;
}

async function main() {
  if (!fs.existsSync(archivePath)) {
    throw new Error(`Archive does not exist: ${archivePath}`);
  }

  const archiveSha256 = await sha256(archivePath);
  const parts = await splitArchive();

  writeJson(manifestPath, {
    version,
    archiveName,
    archiveSha256,
    defaultInstallDir: "pg-data-upper-kit",
    source: {
      type: "npm-registry",
      registry: "https://registry.npmjs.org"
    },
    partScope,
    partNamePrefix,
    partVersion: version,
    parts
  });

  console.log(`Created ${parts.length} part packages.`);
  console.log(`Archive SHA256: ${archiveSha256}`);
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
