import { Octokit } from "@octokit/rest";
import {
  BranchNotFoundError,
  ConflictError,
  TooManyFilesError,
  type CheckRun,
  type GitHubPort,
  type Issue,
  type Permission,
  type Pull,
} from "./port";
import { addedLinesFromPatch } from "../policy/risk";

const MAX_PULL_FILES = 3000;

const PERMISSIONS: readonly Permission[] = ["admin", "maintain", "write", "triage", "read"];

function statusOf(e: unknown): number | undefined {
  if (typeof e === "object" && e !== null && "status" in e)
    return Number((e as { status: unknown }).status);
  return undefined;
}

function labelNames(labels: (string | { name?: string | null })[]): string[] {
  return labels
    .map((l) => (typeof l === "string" ? l : (l.name ?? "")))
    .filter((l) => l.length > 0);
}

interface RawIssue {
  number: number;
  title: string;
  body?: string | null;
  user: { login: string } | null;
  labels: (string | { name?: string | null })[];
  state: string;
  pull_request?: unknown;
}

interface RawPull {
  number: number;
  title: string;
  body: string | null;
  user: { login: string } | null;
  head: { ref: string; sha: string };
  base: { ref: string };
  labels: { name?: string | null }[];
  draft?: boolean;
  state: string;
  merged?: boolean | null;
  merged_at?: string | null;
}

function toIssue(d: RawIssue): Issue {
  return {
    number: d.number,
    title: d.title,
    body: d.body ?? "",
    author: d.user?.login ?? "",
    labels: labelNames(d.labels),
    state: d.state === "closed" ? "closed" : "open",
    isPullRequest: Boolean(d.pull_request),
  };
}

function toPull(d: RawPull): Pull {
  return {
    number: d.number,
    title: d.title,
    body: d.body ?? "",
    author: d.user?.login ?? "",
    headRef: d.head.ref,
    headSha: d.head.sha,
    baseRef: d.base.ref,
    labels: labelNames(d.labels),
    draft: d.draft ?? false,
    state: d.state === "closed" ? "closed" : "open",
    merged: Boolean(d.merged ?? d.merged_at),
  };
}

export function createOctokitPort(o: {
  token: string;
  owner: string;
  repo: string;
  fetch?: typeof fetch;
  excludeRunId?: number | null;
}): GitHubPort {
  const octokit = new Octokit({
    auth: o.token,
    ...(o.fetch ? { request: { fetch: o.fetch } } : {}),
  });
  const base = { owner: o.owner, repo: o.repo };

  return {
    async getIssue(n) {
      const { data } = await octokit.rest.issues.get({ ...base, issue_number: n });
      return toIssue(data);
    },
    async listOpenIssues() {
      const data = await octokit.paginate(octokit.rest.issues.listForRepo, {
        ...base,
        state: "open",
        per_page: 100,
      });
      return data.filter((i) => !i.pull_request).map(toIssue);
    },
    async addLabels(n, labels) {
      if (labels.length > 0)
        await octokit.rest.issues.addLabels({ ...base, issue_number: n, labels });
    },
    async removeLabel(n, label) {
      try {
        await octokit.rest.issues.removeLabel({ ...base, issue_number: n, name: label });
      } catch (e) {
        if (statusOf(e) !== 404) throw e;
      }
    },
    async comment(n, body) {
      await octokit.rest.issues.createComment({ ...base, issue_number: n, body });
    },
    async listComments(n) {
      const data = await octokit.paginate(octokit.rest.issues.listComments, {
        ...base,
        issue_number: n,
        per_page: 100,
      });
      return data.map((c) => ({ id: c.id, author: c.user?.login ?? "", body: c.body ?? "" }));
    },
    async closeIssue(n) {
      await octokit.rest.issues.update({ ...base, issue_number: n, state: "closed" });
    },
    async getPermission(user) {
      try {
        const { data } = await octokit.rest.repos.getCollaboratorPermissionLevel({
          ...base,
          username: user,
        });
        const role = (data as { role_name?: string }).role_name;
        if (role && (PERMISSIONS as readonly string[]).includes(role)) return role as Permission;
        return (PERMISSIONS as readonly string[]).includes(data.permission)
          ? (data.permission as Permission)
          : "none";
      } catch (e) {
        if (statusOf(e) === 404) return "none";
        throw e;
      }
    },
    async getPull(n) {
      const { data } = await octokit.rest.pulls.get({ ...base, pull_number: n });
      return toPull(data);
    },
    async findOpenPullByHead(branch) {
      const { data } = await octokit.rest.pulls.list({
        ...base,
        state: "open",
        head: `${o.owner}:${branch}`,
      });
      const first = data[0];
      return first ? toPull(first) : null;
    },
    async listPullFiles(n) {
      const { data: pull } = await octokit.rest.pulls.get({ ...base, pull_number: n });
      const expected = pull.changed_files;
      if (expected >= MAX_PULL_FILES)
        throw new TooManyFilesError(
          `pull #${n} has ${expected} changed files; GitHub lists at most ${MAX_PULL_FILES}`,
        );
      const files = await octokit.paginate(octokit.rest.pulls.listFiles, {
        ...base,
        pull_number: n,
        per_page: 100,
      });
      if (files.length < expected)
        throw new TooManyFilesError(
          `pull #${n}: GitHub returned ${files.length} of ${expected} changed files`,
        );
      return files.map((f) => ({
        filename: f.filename,
        ...(f.previous_filename ? { previousFilename: f.previous_filename } : {}),
        additions: addedLinesFromPatch(f.patch ?? ""),
      }));
    },
    async createPull(input) {
      const { data } = await octokit.rest.pulls.create({ ...base, ...input });
      return data.number;
    },
    async updatePullBody(n, body) {
      await octokit.rest.pulls.update({ ...base, pull_number: n, body });
    },
    async createReview(n, input) {
      await octokit.rest.pulls.createReview({
        ...base,
        pull_number: n,
        event: input.event,
        body: input.body,
        commit_id: input.commitId,
      });
    },
    async listReviews(n) {
      const data = await octokit.paginate(octokit.rest.pulls.listReviews, {
        ...base,
        pull_number: n,
        per_page: 100,
      });
      return data.map((r) => ({
        author: r.user?.login ?? "",
        state: r.state,
        body: r.body ?? "",
        commitId: r.commit_id ?? "",
      }));
    },
    async listCheckRuns(sha) {
      const runs = await octokit.paginate(octokit.rest.checks.listForRef, {
        ...base,
        ref: sha,
        per_page: 100,
      });
      const latest = new Map<string, { id: number; run: CheckRun }>();
      for (const c of runs) {
        const prev = latest.get(c.name);
        if (!prev || c.id > prev.id)
          latest.set(c.name, {
            id: c.id,
            run: { name: c.name, status: c.status, conclusion: c.conclusion ?? null },
          });
      }
      return [...latest.values()].map((v) => v.run);
    },
    async mergePull(n, input) {
      try {
        const { data } = await octokit.rest.pulls.merge({
          ...base,
          pull_number: n,
          merge_method: "squash",
          sha: input.sha,
          commit_title: input.title,
          commit_message: input.message,
        });
        return data.merged;
      } catch (e) {
        if ([405, 409, 422].includes(statusOf(e) ?? 0)) return false;
        throw e;
      }
    },
    async getCommitMessage(sha) {
      const { data } = await octokit.rest.repos.getCommit({ ...base, ref: sha });
      return data.commit.message;
    },
    async readFile(branch, path) {
      try {
        const { data } = await octokit.rest.repos.getContent({ ...base, path, ref: branch });
        if (Array.isArray(data) || data.type !== "file" || !("content" in data))
          throw new Error(`${path} is not a file`);
        if (data.content === "" && data.size > 0)
          throw new Error(`${path} is too large for the contents API (${data.size} bytes)`);
        return { content: Buffer.from(data.content, "base64").toString("utf8"), sha: data.sha };
      } catch (e) {
        if (statusOf(e) === 404) return null;
        throw e;
      }
    },
    async writeFile(branch, path, content, sha, message) {
      try {
        await octokit.rest.repos.createOrUpdateFileContents({
          ...base,
          path,
          branch,
          message,
          content: Buffer.from(content, "utf8").toString("base64"),
          ...(sha ? { sha } : {}),
        });
      } catch (e) {
        const s = statusOf(e);
        const msg = e instanceof Error ? e.message : "";
        if (s === 409) throw new ConflictError(`${path} changed (409)`);
        if (s === 422 && /sha/i.test(msg)) throw new ConflictError(`${path} changed (422)`);
        if (s === 404 && /branch/i.test(msg))
          throw new BranchNotFoundError(`Branch ${branch} not found`);
        throw e;
      }
    },
    async setVariable(name, value) {
      try {
        await octokit.rest.actions.updateRepoVariable({ ...base, name, value });
      } catch (e) {
        if (statusOf(e) !== 404) throw e;
        await octokit.rest.actions.createRepoVariable({ ...base, name, value });
      }
    },
    async createIssue(title, body, labels) {
      const { data } = await octokit.rest.issues.create({ ...base, title, body, labels });
      return data.number;
    },
    async dispatchWorkflow(file, inputs) {
      await octokit.rest.actions.createWorkflowDispatch({
        ...base,
        workflow_id: file,
        ref: "main",
        inputs,
      });
    },
    async cancelRunsForIssue(issue) {
      // 에이전트 워크플로의 run-name은 "<workflow> [factory/issue-N]" 형식이다(Task 17).
      const tag = `[factory/issue-${issue}]`;
      let cancelled = 0;
      for (const status of ["queued", "in_progress"] as const) {
        const runs = await octokit.paginate(octokit.rest.actions.listWorkflowRunsForRepo, {
          ...base,
          status,
          per_page: 100,
        });
        for (const run of runs) {
          if (run.id === o.excludeRunId) continue;
          if (!(run.display_title ?? "").includes(tag)) continue;
          await octokit.rest.actions.cancelWorkflowRun({ ...base, run_id: run.id });
          cancelled++;
        }
      }
      return cancelled;
    },
    async ensureLabel(name, color, description) {
      try {
        await octokit.rest.issues.getLabel({ ...base, name });
      } catch (e) {
        if (statusOf(e) !== 404) throw e;
        await octokit.rest.issues.createLabel({ ...base, name, color, description });
      }
    },
    async createOrphanBranch(branch, files, message) {
      try {
        await octokit.rest.repos.getBranch({ ...base, branch });
        return;
      } catch (e) {
        if (statusOf(e) !== 404) throw e;
      }
      const tree = await octokit.rest.git.createTree({
        ...base,
        tree: Object.entries(files).map(([path, content]) => ({
          path,
          mode: "100644" as const,
          type: "blob" as const,
          content,
        })),
      });
      const commit = await octokit.rest.git.createCommit({
        ...base,
        message,
        tree: tree.data.sha,
        parents: [],
      });
      await octokit.rest.git.createRef({
        ...base,
        ref: `refs/heads/${branch}`,
        sha: commit.data.sha,
      });
    },
  };
}
