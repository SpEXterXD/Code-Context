import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WatcherService } from "./watcherService";

// WatcherService only reads vscode types (FileSystemWatcher) plus
// workspace.workspaceFolders for path relativization; a minimal module stub
// keeps this suite headless. Fake timers make the debounce deterministic.
vi.mock("vscode", () => ({
  workspace: {
    workspaceFolders: [{ uri: { fsPath: "/ws" } }],
  },
}));

type Listener = (uri: unknown) => void;

function makeService() {
  const calls = {
    changes: [] as string[],
    creates: [] as string[],
    removes: [] as string[],
  };
  const handlers = {
    change: async (rel: string) => {
      calls.changes.push(rel);
    },
    create: async (rel: string) => {
      calls.creates.push(rel);
    },
    remove: async (rel: string) => {
      calls.removes.push(rel);
    },
  };

  const listeners: Record<string, Listener[]> = { create: [], change: [], delete: [] };
  const watcher = {
    onDidCreate: (cb: Listener) => {
      listeners.create.push(cb);
      return { dispose: () => undefined };
    },
    onDidChange: (cb: Listener) => {
      listeners.change.push(cb);
      return { dispose: () => undefined };
    },
    onDidDelete: (cb: Listener) => {
      listeners.delete.push(cb);
      return { dispose: () => undefined };
    },
  };

  const service = new WatcherService(watcher as never, handlers);
  service.start();
  const fire = (rel: string, kind: "create" | "change" | "delete" = "change"): void => {
    const uri = { scheme: "file", fsPath: `/ws/${rel}` };
    for (const listener of listeners[kind]) listener(uri);
  };
  return { service, calls, fire };
}

describe("WatcherService debounce", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("flushes a pending event after the debounce window", async () => {
    const { calls, fire } = makeService();
    fire("src/a.ts");
    await vi.advanceTimersByTimeAsync(599);
    expect(calls.changes).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls.changes).toEqual(["src/a.ts"]);
  });

  it("coalesces a burst into one flush with the latest path set", async () => {
    const { calls, fire } = makeService();
    for (let i = 0; i < 5; i++) {
      fire(`src/a.ts`);
      await vi.advanceTimersByTimeAsync(100);
    }
    await vi.advanceTimersByTimeAsync(600);
    expect(calls.changes).toEqual(["src/a.ts"]);
  });

  it("flushes within debounceMs even when new events keep arriving (F6 starvation)", async () => {
    // Regression: the timer used to reset on every event, so a continuous
    // save stream postponed indexing forever. The first pending event must
    // flush after the debounce window regardless of later events.
    const { calls, fire } = makeService();
    for (let i = 0; i < 6; i++) {
      fire(`src/f${i}.ts`);
      await vi.advanceTimersByTimeAsync(200);
    }
    // 1200 ms of continuous events: at t=600 the first batch must have
    // flushed (pre-fix: zero flushes because the timer kept resetting).
    expect(calls.changes.length).toBeGreaterThanOrEqual(1);
  });

  it("schedules a new flush after a completed one", async () => {
    const { calls, fire } = makeService();
    fire("src/a.ts");
    await vi.advanceTimersByTimeAsync(600);
    expect(calls.changes).toEqual(["src/a.ts"]);
    fire("src/b.ts");
    await vi.advanceTimersByTimeAsync(599);
    expect(calls.changes).toEqual(["src/a.ts"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls.changes).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("routes create and delete events", async () => {
    const { calls, fire } = makeService();
    fire("src/new.ts", "create");
    fire("src/old.ts", "delete");
    await vi.advanceTimersByTimeAsync(600);
    expect(calls.creates).toEqual(["src/new.ts"]);
    expect(calls.removes).toEqual(["src/old.ts"]);
    expect(calls.changes).toHaveLength(0);
  });
});
