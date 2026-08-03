export type ApprovalDecision = "approve" | "deny" | "timeout";

interface PendingApproval {
  runId: string;
  resolve: (decision: ApprovalDecision) => void;
  timer: ReturnType<typeof setTimeout>;
  promise: Promise<ApprovalDecision>;
}

export class ApprovalBroker {
  private readonly pending = new Map<string, PendingApproval>();

  /**
   * Register a pending approval before emitting the event to clients,
   * so ResolveToolApproval can succeed as soon as the event is observed.
   */
  begin(runId: string, approvalId: string, timeoutMs: number): Promise<ApprovalDecision> {
    if (this.pending.has(approvalId)) {
      throw new Error(`Duplicate approval id: ${approvalId}`);
    }

    let settle!: (decision: ApprovalDecision) => void;
    const promise = new Promise<ApprovalDecision>((resolve) => {
      settle = resolve;
    });

    const timer = setTimeout(() => {
      if (!this.pending.has(approvalId)) return;
      this.pending.delete(approvalId);
      settle("timeout");
    }, timeoutMs);

    this.pending.set(approvalId, {
      runId,
      resolve: (decision) => {
        clearTimeout(timer);
        this.pending.delete(approvalId);
        settle(decision);
      },
      timer,
      promise,
    });

    return promise;
  }

  /** @deprecated use begin() */
  wait(runId: string, approvalId: string, timeoutMs: number): Promise<ApprovalDecision> {
    return this.begin(runId, approvalId, timeoutMs);
  }

  resolve(
    runId: string,
    approvalId: string,
    decision: "approve" | "deny",
  ): { ok: boolean; status: string } {
    const pending = this.pending.get(approvalId);
    if (!pending) {
      return { ok: false, status: "not_found" };
    }
    if (pending.runId !== runId) {
      return { ok: false, status: "invalid" };
    }
    pending.resolve(decision);
    return { ok: true, status: decision === "approve" ? "approved" : "denied" };
  }

  cancelRun(runId: string): void {
    for (const [approvalId, pending] of this.pending) {
      if (pending.runId === runId) {
        clearTimeout(pending.timer);
        this.pending.delete(approvalId);
        pending.resolve("deny");
      }
    }
  }

  clearAll(): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.resolve("deny");
    }
    this.pending.clear();
  }
}
