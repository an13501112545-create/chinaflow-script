import fs from "node:fs";

export const OUTREACH_LOCK_PATH = "/var/lib/chinaflow-outreach/unattended-runner-v1.lock";

export function acquireServiceLock(lockPath = OUTREACH_LOCK_PATH) {
  try {
    const fd = fs.openSync(lockPath, "wx", 0o600);
    fs.writeFileSync(fd, `${process.pid}\n`);
    fs.fsyncSync(fd);
    return { acquired: true, fd, path: lockPath };
  } catch (error) {
    if (error?.code === "EEXIST") return { acquired: false, reason: "LOCK_HELD", path: lockPath };
    throw error;
  }
}

export function releaseServiceLock(lock) {
  if (!lock?.acquired) return;
  let sameInode = false;
  try {
    const held = fs.fstatSync(lock.fd);
    const current = fs.statSync(lock.path);
    sameInode = held.dev === current.dev && held.ino === current.ino;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  try {
    fs.closeSync(lock.fd);
  } finally {
    if (sameInode) {
      try { fs.unlinkSync(lock.path); }
      catch (error) { if (error?.code !== "ENOENT") throw error; }
    }
  }
}
