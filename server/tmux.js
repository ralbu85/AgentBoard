const { execSync, execFile } = require("child_process");

function isAlive(sessionName) {
  try {
    execSync(`tmux has-session -t ${sessionName}`, { encoding: "utf8", stdio: "pipe" });
    return true;
  } catch (e) {
    return false;
  }
}

function tmux(cmd) {
  try { return execSync("tmux " + cmd, { encoding: "utf8", stdio: "pipe" }); }
  catch (e) { return ""; }
}

function tmuxAsync(cmd) {
  return new Promise(resolve => {
    execFile("tmux", cmd.split(/\s+/), { encoding: "utf8", timeout: 5000 }, (err, stdout) => {
      resolve(err ? "" : stdout);
    });
  });
}

function tmuxAsyncRaw(args) {
  return new Promise(resolve => {
    execFile("tmux", args, { encoding: "utf8", timeout: 5000 }, (err, stdout) => {
      resolve(err ? "" : stdout);
    });
  });
}

module.exports = { isAlive, tmux, tmuxAsync, tmuxAsyncRaw };
