import { rootServer, JobData, JobInterval, JobScheduleEvent } from "@rootsdk/server-app";
import { log, errMessage } from "./lib/log";

// Root's job scheduler only notifies; the payload lives in our database. A job's
// resourceId is "<kind>:<row id>" and the kind picks the handler. Precision is
// about one minute.
//
// Reliability: jobs survive restarts and missed ones replay at startup, but
// long outages can drop them. Every feature with scheduled work also has a
// reconcile() that runs at startup and from a daily safety-net job and catches
// up on anything overdue.

type Handler = (id: number) => Promise<void>;
const handlers = new Map<string, Handler>();
const reconcilers: Array<() => Promise<void>> = [];

export function onJob(kind: string, handler: Handler): void {
  handlers.set(kind, handler);
}

export function onReconcile(fn: () => Promise<void>): void {
  reconcilers.push(fn);
}

// A one-time job must start in the future, and start times are rounded to the
// nearest minute, so anything sooner than this is pushed out slightly.
const MIN_LEAD_MS = 45_000;

export async function scheduleOnce(kind: string, id: number, at: Date | number): Promise<string> {
  const start = new Date(Math.max(new Date(at).getTime(), Date.now() + MIN_LEAD_MS));
  const job = await rootServer.jobScheduler.create({
    resourceId: `${kind}:${id}`,
    tag: kind,
    jobInterval: JobInterval.OneTime,
    start,
  });
  return job.jobScheduleId;
}

export async function scheduleRepeating(kind: string, id: number, start: Date, interval: JobInterval): Promise<string> {
  const job = await rootServer.jobScheduler.create({ resourceId: `${kind}:${id}`, tag: kind, jobInterval: interval, start });
  return job.jobScheduleId;
}

export async function cancelJobs(kind: string, id: number): Promise<void> {
  await rootServer.jobScheduler.deleteByResourceId(`${kind}:${id}`);
}

export async function hasJob(kind: string, id: number): Promise<boolean> {
  return (await rootServer.jobScheduler.listByResourceId(`${kind}:${id}`)).length > 0;
}

async function dispatch(event: JobData): Promise<void> {
  if (event.resourceId === "sweep:daily") {
    await runReconcile();
    return;
  }
  const [kind, rawId] = event.resourceId.split(":");
  const handler = handlers.get(kind);
  const id = Number(rawId);
  if (!handler || !Number.isInteger(id)) {
    log("warn", "job with no handler", { resourceId: event.resourceId });
    return;
  }
  try {
    await handler(id);
  } catch (err) {
    // Swallow: an unhandled rejection in a job handler restarts the bot, and a
    // crash loop takes it offline. Reconcile retries overdue work later.
    log("error", `job ${event.resourceId} failed`, { error: errMessage(err) });
  }
}

export async function runReconcile(): Promise<void> {
  for (const fn of reconcilers) {
    try {
      await fn();
    } catch (err) {
      log("error", "reconcile step failed", { error: errMessage(err) });
    }
  }
}

export async function initJobs(): Promise<void> {
  rootServer.jobScheduler.on(JobScheduleEvent.Job, (e) => void dispatch(e));
  rootServer.jobScheduler.on(JobScheduleEvent.JobMissed, (e) => void dispatch(e));
  const existing = await rootServer.jobScheduler.listByResourceId("sweep:daily");
  if (existing.length === 0) {
    await rootServer.jobScheduler.create({
      resourceId: "sweep:daily",
      tag: "sweep",
      jobInterval: JobInterval.Daily,
      start: new Date(),
    });
  }
}
