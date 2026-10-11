import type { ChangedFile } from "../policy/risk";

export type { ChangedFile };

export type Permission = "admin" | "maintain" | "write" | "triage" | "read" | "none";

export interface Issue {
  number: number;
  title: string;
  body: string;
  author: string;
  labels: string[];
  state: "open" | "closed";
  isPullRequest: boolean;
}

export interface Comment {
  id: number;
  author: string;
  body: string;
}

export interface Pull {
  number: number;
  title: string;
  body: string;
  author: string;
  headRef: string;
  headSha: string;
  baseRef: string;
  labels: string[];
  draft: boolean;
  state: "open" | "closed";
  merged: boolean;
}

export interface Review {
  author: string;
  state: string;
  body: string;
  commitId: string;
}

export interface CheckRun {
  name: string;
  status: string;
  conclusion: string | null;
}

export interface FileContent {
  content: string;
  sha: string;
}

export class ConflictError extends Error {
  override name = "ConflictError";
}

export interface GitHubPort {
  getIssue(n: number): Promise<Issue>;
  listOpenIssues(): Promise<Issue[]>;
  addLabels(n: number, labels: string[]): Promise<void>;
  removeLabel(n: number, label: string): Promise<void>;
  comment(n: number, body: string): Promise<void>;
  listComments(n: number): Promise<Comment[]>;
  closeIssue(n: number): Promise<void>;
  getPermission(user: string): Promise<Permission>;
  getPull(n: number): Promise<Pull>;
  findOpenPullByHead(branch: string): Promise<Pull | null>;
  listPullFiles(n: number): Promise<ChangedFile[]>;
  createPull(input: {
    title: string;
    body: string;
    head: string;
    base: string;
    draft: boolean;
  }): Promise<number>;
  updatePullBody(n: number, body: string): Promise<void>;
  createReview(
    n: number,
    input: { event: "COMMENT"; body: string; commitId: string },
  ): Promise<void>;
  listReviews(n: number): Promise<Review[]>;
  listCheckRuns(sha: string): Promise<CheckRun[]>;
  mergePull(n: number, input: { sha: string; title: string; message: string }): Promise<boolean>;
  getCommitMessage(sha: string): Promise<string>;
  readFile(branch: string, path: string): Promise<FileContent | null>;
  writeFile(
    branch: string,
    path: string,
    content: string,
    sha: string | null,
    message: string,
  ): Promise<void>;
  setVariable(name: string, value: string): Promise<void>;
  createIssue(title: string, body: string, labels: string[]): Promise<number>;
  dispatchWorkflow(file: string, inputs: Record<string, string>): Promise<void>;
  cancelRunsForIssue(issue: number): Promise<number>;
  ensureLabel(name: string, color: string, description: string): Promise<void>;
  createOrphanBranch(branch: string, files: Record<string, string>, message: string): Promise<void>;
}
