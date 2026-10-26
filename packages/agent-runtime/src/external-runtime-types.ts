export interface ExternalRuntimeExecutionMetadata {
  readonly provider: string;
  readonly model: string;
  readonly runtimeVersion: string;
  readonly authMode: string;
  readonly sandbox: string;
  readonly sessionId?: string | undefined;
}

export interface ExternalRuntimeProcessDiagnostics {
  readonly exitCode: number | null;
  readonly exitSignal: string | null;
  readonly durationMs: number;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly stderrExcerpt?: string | undefined;
}

export interface ExternalRuntimeLimitOptions {
  readonly timeoutMs?: number | undefined;
  readonly terminationGraceMs?: number | undefined;
  readonly maxStdoutBytes?: number | undefined;
  readonly maxStderrBytes?: number | undefined;
}
