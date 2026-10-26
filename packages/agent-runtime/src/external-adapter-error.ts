import type {
  ExternalRuntimeExecutionMetadata,
  ExternalRuntimeProcessDiagnostics,
} from "./external-runtime-types.js";
import type { ExternalProcessResult } from "./external-process.js";

export type ExternalRuntimeAdapterFailureCode =
  | "external_runtime_exit"
  | "external_runtime_empty_output"
  | "external_runtime_protocol_error"
  | "external_runtime_output_limit";

export class ExternalRuntimeAdapterFailure extends Error {
  constructor(
    readonly code: ExternalRuntimeAdapterFailureCode,
    message: string,
    readonly details: {
      readonly result?: ExternalProcessResult | undefined;
      readonly execution?: ExternalRuntimeExecutionMetadata | undefined;
      readonly diagnostics?: ExternalRuntimeProcessDiagnostics | undefined;
    } = {},
  ) {
    super(message);
    this.name = "ExternalRuntimeAdapterFailure";
  }
}
