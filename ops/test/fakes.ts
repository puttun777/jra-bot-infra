/** 試験用の偽物（旧 ops/tests/fakes.py の移植）。実 GCP の代わりの状態機械。呼び出しの順序を calls に残す。 */

import type { BeaconStore, Clock, Gcp } from "../src/ports.js";
import {
  ConflictError,
  type Generation,
  Interrupted,
  type ServiceState,
  type SqlState,
  type StateStore,
  UnknownOutcomeError,
} from "../src/ports.js";

export class FakeStore implements StateStore {
  state: unknown;
  gen: Generation;
  history: string[] = [];
  failAfterWrites: number | undefined;
  writes = 0;
  conflictNext = false;
  /** 次の書込みは成立させたうえで、応答を失わせる（UnknownOutcomeError） */
  loseResponseNext = false;
  /** 次の書込みを成立させずに結果不明にする */
  failUnknownNext = false;
  /** 書込みの直前に他者が割り込む（generation を進める） */
  interleave: (() => void) | undefined;

  constructor(state?: unknown) {
    this.state = state === undefined ? undefined : structuredClone(state);
    this.gen = state === undefined ? 0n : 1n;
  }

  async read(): Promise<{ raw: unknown; generation: Generation }> {
    return { raw: this.state === undefined ? undefined : structuredClone(this.state), generation: this.gen };
  }

  async write(state: unknown, ifGeneration: Generation): Promise<Generation> {
    if (this.interleave !== undefined) {
      const f = this.interleave;
      this.interleave = undefined;
      f();
    }
    if (this.conflictNext) {
      this.conflictNext = false;
      throw new ConflictError("412");
    }
    if (this.failUnknownNext) {
      this.failUnknownNext = false;
      throw new UnknownOutcomeError("connection reset");
    }
    if (ifGeneration !== this.gen) throw new ConflictError("412");
    this.writes++;
    if (this.failAfterWrites !== undefined && this.writes > this.failAfterWrites) throw new Error("GCS が書けない");
    this.state = structuredClone(state);
    this.gen += 1n;
    if (this.loseResponseNext) {
      this.loseResponseNext = false;
      throw new UnknownOutcomeError("応答が失われた");
    }
    return this.gen;
  }

  async appendHistory(name: string): Promise<void> {
    this.history.push(name);
  }
}

export class FakeBeacon implements BeaconStore {
  writes: Record<string, unknown>[] = [];
  raws: Buffer[] = [];
  async write(raw: Buffer): Promise<void> {
    this.raws.push(raw);
    this.writes.push(JSON.parse(raw.toString("utf8")) as Record<string, unknown>);
  }
}

export class FakeClock implements Clock {
  t = 0;
  sleeps: number[] = [];
  now(): string {
    return `2026-11-01T10:${String(Math.floor(this.t / 60) % 60).padStart(2, "0")}:${String(this.t % 60).padStart(2, "0")}Z`;
  }
  async sleep(seconds: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted === true) throw new Interrupted("中断");
    this.sleeps.push(seconds);
    this.t += Math.floor(seconds);
  }
}

interface FakeService {
  ingress: string;
  ready: boolean;
  iapEnabled: boolean;
  iapMembers: number;
  url: string;
}

export class FakeGcp implements Gcp {
  sql: { state: string; activationPolicy: string } = { state: "STOPPED", activationPolicy: "NEVER" };
  sqlUpAfter = 0;
  polls = 0;
  services: Record<string, FakeService> = {
    "jra-bot-ingest": { ingress: "internal", ready: true, iapEnabled: false, iapMembers: 0, url: "https://ingest" },
    "jra-bot-dashboard": { ingress: "internal", ready: true, iapEnabled: true, iapMembers: 1, url: "https://dash" },
  };
  health: Record<string, number> = { "jra-bot-ingest": 200, "jra-bot-dashboard": 200 };
  executions: string[] = [];
  drainAfterPolls: number | undefined;
  private execPolls = 0;
  cancelWorks = true;
  scheduler: Record<string, string> = { "jra-bot-calendar-check": "PAUSED", "jra-bot-reconcile": "PAUSED", "jra-bot-retention": "PAUSED" };
  jobExit: Record<string, number> = { "--mode=validate": 0, "--mode=migrate": 0 };
  externallyReachable = false;
  calls: string[] = [];
  jobImages: Record<string, string> = {};
  serviceImages: Record<string, string> = {};
  /** 試験が差し替える関数 */
  hooks: Partial<{
    sqlSetActivation: (p: string) => Promise<void>;
    sqlState: () => Promise<SqlState>;
    schedulerStates: () => Promise<Record<string, string>>;
    runJob: (job: string, args: readonly string[]) => Promise<number>;
    serviceSetImage: (name: string, image: string) => Promise<void>;
    jobSetImage: (job: string, image: string) => Promise<void>;
  }> = {};

  svc(name: string): FakeService {
    const s = this.services[name];
    if (s === undefined) throw new Error(`未知のサービス ${name}`);
    return s;
  }

  async rawSqlState(): Promise<SqlState> {
    if (this.sql.activationPolicy === "ALWAYS" && this.sql.state !== "RUNNABLE") {
      this.polls++;
      if (this.polls > this.sqlUpAfter) this.sql.state = "RUNNABLE";
    }
    return { state: this.sql.state, activationPolicy: this.sql.activationPolicy };
  }

  async sqlState(): Promise<SqlState> {
    return this.hooks.sqlState !== undefined ? this.hooks.sqlState() : this.rawSqlState();
  }

  async rawSqlSetActivation(policy: string): Promise<void> {
    this.calls.push(`sql:${policy}`);
    this.sql.activationPolicy = policy;
    if (policy === "NEVER") this.sql.state = "STOPPED";
    else this.polls = 0;
  }

  async sqlSetActivation(policy: "ALWAYS" | "NEVER"): Promise<void> {
    return this.hooks.sqlSetActivation !== undefined ? this.hooks.sqlSetActivation(policy) : this.rawSqlSetActivation(policy);
  }

  async sqlBackup(): Promise<void> {
    this.calls.push("sql:backup");
  }

  async serviceState(name: string): Promise<ServiceState> {
    return { ...this.svc(name) };
  }

  async serviceSetIngress(name: string, ingress: "all" | "internal"): Promise<void> {
    this.calls.push(`ingress:${name}:${ingress}`);
    this.svc(name).ingress = ingress;
  }

  async serviceHealth(name: string): Promise<number> {
    this.calls.push(`health:${name}`);
    return this.health[name] ?? 0;
  }

  async serviceReachableExternally(): Promise<boolean> {
    return this.externallyReachable;
  }

  async runningExecutions(): Promise<string[]> {
    if (this.drainAfterPolls !== undefined) {
      this.execPolls++;
      if (this.execPolls > this.drainAfterPolls) this.executions = [];
    }
    return [...this.executions];
  }

  async cancelExecution(execution: string): Promise<void> {
    this.calls.push(`cancel:${execution}`);
    if (this.cancelWorks) this.executions = this.executions.filter((e) => e !== execution);
  }

  async runJob(job: string, args: readonly string[]): Promise<number> {
    if (this.hooks.runJob !== undefined) return this.hooks.runJob(job, args);
    this.calls.push(`job:${job}:${args[0] ?? ""}`);
    return this.jobExit[args[0] ?? ""] ?? 1;
  }

  async jobImage(job: string): Promise<string | undefined> {
    return this.jobImages[job];
  }

  async jobSetImage(job: string, image: string): Promise<void> {
    if (this.hooks.jobSetImage !== undefined) return this.hooks.jobSetImage(job, image);
    this.calls.push(`job-image:${job}`);
    this.jobImages[job] = image;
  }

  async serviceImage(name: string): Promise<string | undefined> {
    return this.serviceImages[name];
  }

  async serviceSetImage(name: string, image: string): Promise<void> {
    if (this.hooks.serviceSetImage !== undefined) return this.hooks.serviceSetImage(name, image);
    this.calls.push(`svc-image:${name}`);
    this.serviceImages[name] = image;
  }

  async schedulerStates(): Promise<Record<string, string>> {
    return this.hooks.schedulerStates !== undefined ? this.hooks.schedulerStates() : { ...this.scheduler };
  }

  async schedulerPause(name: string): Promise<void> {
    this.calls.push(`pause:${name}`);
    this.scheduler[name] = "PAUSED";
  }

  async schedulerResume(name: string): Promise<void> {
    this.calls.push(`resume:${name}`);
    this.scheduler[name] = "ENABLED";
  }
}
