// Lightweight in-memory job store for long-running tasks (crawl + send).
// The frontend polls GET /api/<type>/:id to show live progress.

export type JobType = "crawl" | "send";

export interface Job {
  id: string;
  type: JobType;
  status: "running" | "done" | "error";
  progress: number; // 0..1
  total: number;
  processed: number;
  logs: any[];
  result?: any;
  error?: string;
  startedAt: number;
}

const jobs = new Map<string, Job>();

export function createJob(type: JobType, total = 0): Job {
  const job: Job = {
    id: crypto.randomUUID(),
    type,
    status: "running",
    progress: 0,
    total,
    processed: 0,
    logs: [],
    startedAt: Date.now(),
  };
  jobs.set(job.id, job);
  return job;
}

export function getJob(id: string): Job | undefined {
  return jobs.get(id);
}

export function log(job: Job, entry: any) {
  job.logs.push({ t: Date.now(), ...entry });
  if (job.logs.length > 800) job.logs.shift();
}

// Reap finished jobs after 30 minutes so memory stays bounded.
setInterval(() => {
  const now = Date.now();
  for (const [id, j] of jobs) {
    if (now - j.startedAt > 1000 * 60 * 30) jobs.delete(id);
  }
}, 60_000);
