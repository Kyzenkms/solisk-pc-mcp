const { execFileSync } = require("child_process");
const path = require("path");

function git(argsArray, cwd, timeout_ms = 30000) {
  try {
    const result = execFileSync("git", argsArray, {
      encoding: "utf8",
      timeout: typeof timeout_ms === "number" && timeout_ms > 0 ? timeout_ms : 30000,
      cwd: cwd || process.cwd(),
      windowsHide: true,
    });
    return { success: true, output: result.trim() };
  } catch (err) {
    return { success: false, output: err.stdout?.trim() || "", error: err.stderr?.trim() || err.message };
  }
}

const gitTools = [
  {
    name: "git_status",
    description: "Get the current git status of a repository (modified files, staged files, branch, etc.).",
    inputSchema: {
      type: "object",
      properties: {
        repo_path: { type: "string", description: "Path to the git repository (default: current dir)" },
        timeout_ms: { type: "number", description: "Execution timeout in milliseconds (default: 30000)", default: 30000 },
      },
    },
    handler: async ({ repo_path, timeout_ms = 30000 }) => {
      const cwd = repo_path ? path.resolve(repo_path) : process.cwd();
      const status = git(["status"], cwd, timeout_ms);
      const branch = git(["branch", "--show-current"], cwd, timeout_ms);
      const log = git(["log", "--oneline", "-5"], cwd, timeout_ms);
      
      if (status.success || branch.success) {
        return {
          success: true,
          data: {
            branch: branch.output,
            status: status.output,
            recent_commits: log.output
          }
        };
      }
      return { success: false, error: status.error || branch.error || "Failed to get git status", code: "GIT_STATUS_FAILED" };
    },
  },
  {
    name: "git_clone",
    description: "Clone a git repository to a local directory.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Repository URL to clone" },
        destination: { type: "string", description: "Local path to clone into (optional)" },
      },
      required: ["url"],
    },
    handler: async ({ url, destination }) => {
      const argsArray = destination ? ["clone", url, path.resolve(destination)] : ["clone", url];
      const res = git(argsArray);
      if (res.success) {
        return { success: true, data: { output: res.output } };
      }
      return { success: false, error: res.error, code: "GIT_CLONE_FAILED" };
    },
  },
  {
    name: "git_add",
    description: "Stage files for commit.",
    inputSchema: {
      type: "object",
      properties: {
        repo_path: { type: "string", description: "Repository path" },
        files: { type: "string", description: "Files to add (default: '.' for all)", default: "." },
      },
    },
    handler: async ({ repo_path, files = "." }) => {
      const cwd = repo_path ? path.resolve(repo_path) : process.cwd();
      const res = git(["add", files], cwd);
      if (res.success) {
        return { success: true, data: { output: res.output } };
      }
      return { success: false, error: res.error, code: "GIT_ADD_FAILED" };
    },
  },
  {
    name: "git_commit",
    description: "Commit staged changes with a message.",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: "Commit message" },
        repo_path: { type: "string", description: "Repository path" },
        add_all: { type: "boolean", description: "If true, stage all changes before committing", default: true },
      },
      required: ["message"],
    },
    handler: async ({ message, repo_path, add_all = true }) => {
      const cwd = repo_path ? path.resolve(repo_path) : process.cwd();
      if (add_all) git(["add", "."], cwd);
      const res = git(["commit", "-m", message], cwd);
      if (res.success) {
        return { success: true, data: { output: res.output } };
      }
      return { success: false, error: res.error, code: "GIT_COMMIT_FAILED" };
    },
  },
  {
    name: "git_push",
    description: "Push commits to the remote repository.",
    inputSchema: {
      type: "object",
      properties: {
        repo_path: { type: "string", description: "Repository path" },
        remote: { type: "string", description: "Remote name (default: origin)", default: "origin" },
        branch: { type: "string", description: "Branch name (default: current branch)" },
      },
    },
    handler: async ({ repo_path, remote = "origin", branch = "" }) => {
      const cwd = repo_path ? path.resolve(repo_path) : process.cwd();
      const args = ["push", remote];
      if (branch) args.push(branch);
      const res = git(args, cwd);
      if (res.success) {
        return { success: true, data: { output: res.output } };
      }
      return { success: false, error: res.error, code: "GIT_PUSH_FAILED" };
    },
  },
  {
    name: "git_pull",
    description: "Pull latest changes from the remote repository.",
    inputSchema: {
      type: "object",
      properties: {
        repo_path: { type: "string", description: "Repository path" },
        remote: { type: "string", description: "Remote name (default: origin)", default: "origin" },
      },
    },
    handler: async ({ repo_path, remote = "origin" }) => {
      const cwd = repo_path ? path.resolve(repo_path) : process.cwd();
      const res = git(["pull", remote], cwd);
      if (res.success) {
        return { success: true, data: { output: res.output } };
      }
      return { success: false, error: res.error, code: "GIT_PULL_FAILED" };
    },
  },
  {
    name: "git_log",
    description: "View recent git commit history.",
    inputSchema: {
      type: "object",
      properties: {
        repo_path: { type: "string", description: "Repository path" },
        count: { type: "number", description: "Number of commits to show (default: 10)", default: 10 },
      },
    },
    handler: async ({ repo_path, count = 10 }) => {
      const cwd = repo_path ? path.resolve(repo_path) : process.cwd();
      const res = git(["log", "--oneline", "--decorate", `-${count}`], cwd);
      if (res.success) {
        return { success: true, data: { output: res.output } };
      }
      return { success: false, error: res.error, code: "GIT_LOG_FAILED" };
    },
  },
  {
    name: "git_diff",
    description: "Show changes between working directory and last commit.",
    inputSchema: {
      type: "object",
      properties: {
        repo_path: { type: "string", description: "Repository path" },
        file: { type: "string", description: "Specific file to diff (optional)" },
        staged: { type: "boolean", description: "Show staged changes", default: false },
      },
    },
    handler: async ({ repo_path, file = "", staged = false }) => {
      const cwd = repo_path ? path.resolve(repo_path) : process.cwd();
      const args = ["diff"];
      if (staged) args.push("--cached");
      if (file) args.push(file);
      const res = git(args, cwd);
      if (res.success) {
        return { success: true, data: { output: res.output } };
      }
      return { success: false, error: res.error, code: "GIT_DIFF_FAILED" };
    },
  },
  {
    name: "git_branch",
    description: "List branches, create a new branch, or switch to an existing branch.",
    inputSchema: {
      type: "object",
      properties: {
        repo_path: { type: "string", description: "Repository path" },
        action: {
          type: "string",
          description: "Action: list, create, switch, delete (default: list)",
          default: "list",
        },
        branch_name: { type: "string", description: "Branch name (required for create/switch/delete)" },
      },
    },
    handler: async ({ repo_path, action = "list", branch_name }) => {
      const cwd = repo_path ? path.resolve(repo_path) : process.cwd();
      let res;
      switch (action) {
        case "list":    res = git(["branch", "-a"], cwd); break;
        case "create":  res = git(["checkout", "-b", branch_name], cwd); break;
        case "switch":  res = git(["checkout", branch_name], cwd); break;
        case "delete":  res = git(["branch", "-d", branch_name], cwd); break;
        default:        res = git(["branch", "-a"], cwd); break;
      }
      if (res.success) {
        return { success: true, data: { output: res.output } };
      }
      return { success: false, error: res.error, code: "GIT_BRANCH_FAILED" };
    },
  },
  {
    name: "git_init",
    description: "Initialize a new git repository in a directory.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory to initialize as a git repo" },
      },
      required: ["path"],
    },
    handler: async ({ path: repoPath }) => {
      const fs = require("fs");
      const cwd = path.resolve(repoPath);
      const res = git(["init"], cwd);
      if (res.success) {
        const ignorePath = path.join(cwd, ".gitignore");
        if (!fs.existsSync(ignorePath)) {
          const defaultIgnore = `# Default .gitignore
node_modules/
.venv/
__pycache__/
*.pyc
dist/
build/
.env
*.log
tmp/
.DS_Store
Thumbs.db
`;
          try { fs.writeFileSync(ignorePath, defaultIgnore, "utf8"); } catch {}
        }
        return { success: true, data: { output: res.output, gitignore_scaffolded: true } };
      }
      return { success: false, error: res.error, code: "GIT_INIT_FAILED" };
    },
  },
];

module.exports = gitTools;
