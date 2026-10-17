const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const rootDir = path.resolve(__dirname, "..");
const workflowPath = path.join(rootDir, ".github", "workflows", "private-backup.yml");

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: options.input ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
    ...options,
  });
}

function git(repoDir, args) {
  return run("git", args, { cwd: repoDir }).trim();
}

function extractCommitScript() {
  const lines = fs.readFileSync(workflowPath, "utf8").split(/\r?\n/);
  const nameIndex = lines.findIndex((line) => line.includes("- name: Commit backup when changed"));
  assert.notEqual(nameIndex, -1, "workflow should include the backup commit step");
  const runIndex = lines.findIndex((line, index) => index > nameIndex && line.trim() === "run: |");
  assert.notEqual(runIndex, -1, "backup commit step should use a shell run block");
  const runIndent = lines[runIndex].match(/^\s*/)[0].length;
  const scriptLines = [];
  for (const line of lines.slice(runIndex + 1)) {
    const indent = line.match(/^\s*/)[0].length;
    if (line.trim() && indent <= runIndent) break;
    scriptLines.push(line.slice(runIndent + 2));
  }
  return scriptLines.join("\n");
}

function writeBackup(repoDir, hash) {
  const backupDir = path.join(repoDir, "private-backups");
  fs.mkdirSync(backupDir, { recursive: true });
  const body = JSON.stringify({ schemaVersion: 1, hash, export: { hash, lessons: [] } }, null, 2);
  fs.writeFileSync(path.join(backupDir, "latest.json"), `${body}\n`);
  fs.writeFileSync(path.join(backupDir, "2026-10-05.json"), `${body}\n`);
}

function createArchiveRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "daily-cs-private-backup-workflow-"));
  const remoteDir = path.join(root, "remote.git");
  const repoDir = path.join(root, "archive");
  run("git", ["init", "--bare", remoteDir]);
  run("git", ["init", repoDir]);
  git(repoDir, ["config", "user.name", "test"]);
  git(repoDir, ["config", "user.email", "test@example.invalid"]);
  fs.writeFileSync(path.join(repoDir, "README.md"), "synthetic archive\n");
  git(repoDir, ["add", "README.md"]);
  git(repoDir, ["commit", "-m", "Initial archive"]);
  git(repoDir, ["branch", "-M", "main"]);
  git(repoDir, ["remote", "add", "origin", remoteDir]);
  git(repoDir, ["push", "-u", "origin", "main"]);
  return repoDir;
}

function runCommitStep(repoDir) {
  const bash = process.platform === "win32" && fs.existsSync("C:\\Program Files\\Git\\bin\\bash.exe")
    ? "C:\\Program Files\\Git\\bin\\bash.exe"
    : "bash";
  return run(bash, ["-lc", extractCommitScript()], { cwd: repoDir });
}

test("private backup workflow commits the first untracked backup, skips unchanged backup, and commits changed backup", () => {
  const repoDir = createArchiveRepo();

  writeBackup(repoDir, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  runCommitStep(repoDir);
  assert.match(git(repoDir, ["status", "--short", "--", "private-backups"]), /^$/);
  assert.equal(git(repoDir, ["rev-list", "--count", "HEAD"]), "2");

  runCommitStep(repoDir);
  assert.equal(git(repoDir, ["rev-list", "--count", "HEAD"]), "2");

  writeBackup(repoDir, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  runCommitStep(repoDir);
  assert.equal(git(repoDir, ["rev-list", "--count", "HEAD"]), "3");
  assert.match(git(repoDir, ["log", "-1", "--pretty=%s"]), /bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/);
});
