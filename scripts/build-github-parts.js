const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const rootDir = path.resolve(__dirname, "..");
const archiveName = "pg-data-upper-kit-1.0.2.tar.gz";
const archivePath = path.join(rootDir, ".dist", archiveName);
const partsRoot = path.join(rootDir, "release-parts");
const manifestPath = path.join(rootDir, "package-parts.json");

const version = "1.0.2";
const chunkSize = 45 * 1024 * 1024;

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
    if (entry.startsWith(`${archiveName}.part-`)) {
      fs.rmSync(path.join(partsRoot, entry), { force: true });
    }
  }

  const parts = [];
  const input = fs.openSync(archivePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let partIndex = 1;
  let currentBytes = 0;
  let currentFd = null;
  let currentFileName = "";

  function openPart() {
    const suffix = String(partIndex).padStart(3, "0");
    currentFileName = `${archiveName}.part-${suffix}`;
    currentFd = fs.openSync(path.join(partsRoot, currentFileName), "w");
    currentBytes = 0;
    parts.push({ file: currentFileName });
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
      type: "github-raw",
      baseUrl: "https://raw.githubusercontent.com/Informativus/pg-data-upper/main/release-parts"
    },
    parts
  });

  console.log(`Created ${parts.length} GitHub parts.`);
  console.log(`Archive SHA256: ${archiveSha256}`);
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
