import {
  DEFAULT_MAX_TOKENS,
  type RecoveryOptions,
  resolveRecoveryOptions,
} from "./constants.js";

export class RecoveryState {
  maxTokens: number;
  hasEscalated = false;
  continuationCount = 0;
  hasReactiveCompact = false;
  transientAttempt = 0;
  consecutiveOverloaded = 0;
  currentModel: string;
  readonly options: ReturnType<typeof resolveRecoveryOptions>;

  constructor(input: { model: string; recovery?: RecoveryOptions }) {
    this.options = resolveRecoveryOptions(input.recovery ?? {});
    this.maxTokens = this.options.defaultMaxTokens;
    this.currentModel = input.model;
  }

  resetTransientCountersOnSuccess(): void {
    this.transientAttempt = 0;
    this.consecutiveOverloaded = 0;
  }
}

export { DEFAULT_MAX_TOKENS };
