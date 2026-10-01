import fs from "node:fs";

export const HALT_LOCK_PATH = "/var/lib/chinaflow-outreach/unattended-live-halt-v1.json";

export function readPersistentHalt(path = HALT_LOCK_PATH) {
  try {
    const raw = fs.readFileSync(path, "utf8");
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch { return { present: true, malformed: true, reason: "HALT_LOCK_MALFORMED", path }; }
    return {
      present: true,
      malformed: false,
      reason: typeof parsed.reason === "string" && parsed.reason ? parsed.reason : "UNKNOWN",
      prospectId: parsed.prospectId == null ? null : String(parsed.prospectId),
      createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : null,
      path,
    };
  } catch (error) {
    if (error?.code === "ENOENT") return { present: false, path };
    throw error;
  }
}

export function writePersistentHalt({ prospectId = null, reason = "UNKNOWN", createdAt = new Date().toISOString() } = {}, path = HALT_LOCK_PATH) {
  const payload = JSON.stringify({
    version: 1,
    prospectId: prospectId == null ? null : String(prospectId),
    reason: String(reason || "UNKNOWN"),
    createdAt: String(createdAt),
  }) + "\n";
  let fd;
  try {
    fd = fs.openSync(path, "wx", 0o600);
    fs.writeFileSync(fd, payload, "utf8");
    fs.fsyncSync(fd);
    return { written: true, path };
  } catch (error) {
    if (error?.code === "EEXIST") return { written: false, reason: "HALT_LOCK_ALREADY_EXISTS", path };
    throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
