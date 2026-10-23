export type RequestPriority = "high" | "low";

interface Job {
  key: string;
  run: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  priority: RequestPriority;
  started: boolean;
}

export class DroppedRequestError extends Error {
  constructor() {
    super("Background request dropped");
    this.name = "DroppedRequestError";
  }
}

/**
 * Deduplicating request queue. High-priority jobs (what the user tapped) start
 * immediately; low-priority prefetches run only while no high job is in
 * flight, a few at a time, in FIFO order. Requesting a queued low job with
 * high priority promotes it.
 */
export class KeyedRequestQueue {
  private readonly jobs = new Map<string, Job>();
  private readonly promises = new Map<string, Promise<unknown>>();
  private queue: Job[] = [];
  private highRunning = 0;
  private lowRunning = 0;

  constructor(private readonly lowConcurrency = 3) {}

  request<T>(key: string, run: () => Promise<T>, priority: RequestPriority): Promise<T> {
    const existing = this.promises.get(key);
    if (existing) {
      const job = this.jobs.get(key);
      if (job && !job.started && priority === "high" && job.priority === "low") {
        job.priority = "high";
        this.pump();
      }
      return existing as Promise<T>;
    }

    let job!: Job;
    const promise = new Promise<unknown>((resolve, reject) => {
      job = { key, run, resolve, reject, priority, started: false };
    });
    this.jobs.set(key, job);
    this.promises.set(key, promise);
    // A failed or dropped request may be retried later.
    promise.catch(() => {
      if (this.promises.get(key) === promise) this.promises.delete(key);
    });
    this.queue.push(job);
    this.pump();
    return promise as Promise<T>;
  }

  /** Drops background jobs that have not started yet. */
  dropPendingLow(): void {
    const dropped = this.queue.filter((job) => job.priority === "low");
    this.queue = this.queue.filter((job) => job.priority !== "low");
    for (const job of dropped) {
      this.jobs.delete(job.key);
      job.reject(new DroppedRequestError());
    }
  }

  private pump(): void {
    for (const job of this.queue.filter((item) => item.priority === "high")) {
      this.start(job);
    }
    while (this.highRunning === 0 && this.lowRunning < this.lowConcurrency) {
      const next = this.queue.find((item) => item.priority === "low");
      if (!next) break;
      this.start(next);
    }
  }

  private start(job: Job): void {
    this.queue = this.queue.filter((item) => item !== job);
    job.started = true;
    const high = job.priority === "high";
    if (high) this.highRunning += 1;
    else this.lowRunning += 1;
    let task: Promise<unknown>;
    try {
      task = job.run();
    } catch (err) {
      task = Promise.reject(err);
    }
    task.then(job.resolve, job.reject).finally(() => {
      if (high) this.highRunning -= 1;
      else this.lowRunning -= 1;
      this.jobs.delete(job.key);
      this.pump();
    });
  }
}
